# Engine: 3D

How the Rust engine evaluates and draws StykAnimate's 3D: spatial poses
(`_stykSpatial`: perspective and part proportions), one-sided surfaces
(`_stykSurface`), figure meshes (`_styk.spatialMesh`) and attached movieclip
meshes (`spatialMeshes`). The user-facing behaviour is in
[`SPATIAL-MESHES.md`](../SPATIAL-MESHES.md) and [`RIG-CONSTRAINTS.md`](../RIG-CONSTRAINTS.md);
the JavaScript editor is the oracle while both exist
([`RUST-ENGINE-PORT.md`](../RUST-ENGINE-PORT.md)): `src/spatial-projection.mjs`,
`src/rig-spatial.mjs`, `src/pivot/surfaces.mjs`, `src/spatial-mesh.mjs`,
`src/movieclip-mesh.mjs`, the polygon and mesh steps of `buildGeometrySteps`
(`src/pivot/geometry.mjs`), and for drawing `src/surface-raster.mjs`,
`src/renderer-mesh-raster.mjs` and the raster path of `src/renderer.mjs`.

## Contract

- **Typed views** (`styk_eval::load`, `doc.rs`): `Object::spatial` (`SpatialPose`:
  camera strength, distance and optional centre; width and taper by bone handle),
  `Polyfill::surface` (`Surface`: reference triangle, side, flip, depth guides,
  depth test), `Segment::choice_scale` (a pose choice whose hidden length is 0),
  `Figure::mesh` (`spatial::MeshPlan`, compiled once against the figure's joints,
  `spatialMeshPlan`) with `Figure::mesh_colors` (the palette after the instance's
  `_stykStyle.meshColors`), `Movieclip::meshes` (`spatial::ClipMesh`, one per local
  frame). A mesh or clip mesh that is not a valid indexed mesh is left out and noted
  (`Document::notes`); the editor rejects such a file when it loads.
- **Evaluation** is a pure function of the frame, as everywhere: no per-pose cache
  (the editor's `previous` evaluations and artwork signatures are memoization).
- **Geometry** (`geometry::build`): per object `ObjectGeometry::spatial` (each
  bone's frame, each joint's depth guide `depthOffset` and unprojected point
  `rawPoint`, the figure's rotation, reflection and perspective); per scene the
  evaluated meshes (`Scene::meshes`, `MeshGeometry`: positions and depths rounded to
  single precision where the editor stores `Float32Array`s, visible faces, palette,
  bounds, depth range) and the depths of depth-tested surfaces (`Scene::depths`).
  Drawables gain `ItemKind::Mesh` (a painter-order bucket of a mesh's faces:
  `Item::mesh`, `Item::faces`), and a polygon that is a depth-tested surface carries
  one depth per point (`Item::depth`). `Item::depth_surface` is `depthSurface`.
- `Document::unsupported` names no 3D feature, and the interface refuses no 3D document: drawings a spatial bone
  turns (`drawingRotation`) are evaluated too (step 6 below). `Movieclip::drawing_sets`
  and `Movieclip::drawing_rotation` hold a clip's forms and their rotation;
  `ObjectSpatial` keeps each joint's authored angle and a bone's start before perspective
  (`start.rawPoint`) for them.

## Evaluation (`styk_eval::spatial`, `rig.rs`, `geometry.rs`)

Operation for operation as the editor, with V8's trigonometry and `Math.hypot`
(`styk-math`, D16) in the whole spatial path: whether an edge-on face is culled is
decided by a tolerance of 2e-7 relative to the face, so the last bits matter.

1. **Spatial poses between keys** (`spatial::interpolate_pose`, called from
   `eval::tween_object`): `interpolateSpatialPose`. The camera is always present (a
   key without one takes strength 0, distance 600, its own root as centre), each
   value linear within its limits; proportions of the bones either key names.
2. **Bones** (`rig::evaluate_spatial`, `evaluateSpatial`): the pose's perspective
   (`spatial::Camera::of`, `projection`) projects every joint
   (`projectSpatial`, near limit 0.05) and keeps the unprojected point; part
   proportions move points radially (`shapeOffset`, also blended over the bindings
   of skin points); a hidden pose choice scales about the bone's origin by its
   stretch (`choiceScale`). Every spatial joint and every weighted joint with a depth
   anchor records its depth guide. Inverse kinematics evaluates without perspective,
   as `createRigEvaluation(..., {project: false})`.
3. **Surfaces** (`spatial::evaluate_surface`, `project_face`): a depth-tested face of
   a perspective pose is clipped against the near plane before projection (a
   triangle may become a quad) and takes its corners' perspective depths; otherwise
   depth guides project onto the reference X axis (`depthOffset` where a joint has
   one). The face is culled by its reference parity, side and flip with the native
   edge-on tolerance (`surfaceCulled`); a culled face is dropped. Its painter order is
   `z_order` plus the mean guide depth.
4. **Figure meshes** (`spatial::evaluate_mesh`, `evaluateSpatialMeshSteps`): after the
   bones, every vertex is skinned (`framePoint` for one bone, with view targets
   blended around the bone's heading; `blendedVertex` for several: dual quaternions,
   or a linear blend while a bone stretches, radial proportions blended in bind
   space), placed by the figure's rotation, scale and reflection, projected; faces
   are kept by the reference parity and clipped at the near plane. The mesh is then
   split where the figure's other visible primitives lie in painter order
   (`spatialMeshDrawables`; zero-width lines do not split it, a face tied with a
   level goes below it), faces regrouped by bucket in their order.
5. **Attached movieclip meshes** (`spatial::evaluate_clip_mesh`,
   `buildMovieclipMeshSteps`): joined to a spatial bone, the bone alone owns the
   orientation (the instance's root is the bone's start; the affine fast path when no
   taper; view sets blended around the bone's heading with per-view turns and turn
   weights); otherwise placed flat by the instance's angle, scale and reflection. The
   form is `floor(local time)` clamped to the clip's forms. Faces are kept by their
   outward winding and clipped like surfaces.
6. **Rotated drawings** (`geometry::rotated_drawing`, `rotatedDrawing`,
   `drawingRotationReference`, `buildMovieclipGeometrySteps`): a movieclip joined to a
   spatial bone shows the single frame its bone selects in the instance's form
   (`drawingSelection`: the set holding the instance's frame): the bone's rotation as bend,
   turn and pitch on the Euler branch nearest the native angles of its turn and tilt
   controls up the chain (`rig::quaternion_pose`, `quaternionPose`), the turn rounded to one
   of `steps` directions and the pitch past the tilt threshold choosing the up or down
   views. The instance is placed at the bone's start, turned by the bend (reflected with its
   parent) and the figure's rotation, scaled by the bone's stretch and, in perspective, by
   its depth (`1 / max(.05, 1 - k z)`), all with V8's trigonometry (`styk-math`).
7. **Records** (`records.rs`): a tween of `_stykSpatial` is written as
   `interpolateSpatialPose`'s record (camera, then proportions in ascending handle
   order), from the typed tween.

## Drawing

### Depth runs (`styk-draw`, `drawlist.rs`)

The editor composites consecutive depth-tested faces of one figure as one depth
raster at its painter position (`paintDepthSurfaces`, `rasterizeMeshGroup`): within
the run a face hides what is behind it, and the run as a whole sits over what was
drawn before it. The draw list says the same: `K_DEPTH_RESET` starts a run over a
rectangle covering its faces, then each face is a `K_TRI` with `F_DEPTH` carrying
its three corner depths and the run's smallest depth and range. Depths are
normalized over the run as the editor does (each mesh's whole range, each surface's
corner depths) and mapped to window depths with the editor's expression
`0.9995 - 0.999 * (z - zMin) / range` (`styk_draw::window_depth`): smaller is nearer,
an equal depth keeps the later face. Onion skins draw every face in their tint.

### Raster entries (`LayerKind::Raster`)

The editor draws an object or movieclip instance that holds depth-tested faces from
a raster of its own (`requiresCompatibilityTexture`, then `rasterObject`), resampled
into the frame, even when it has no effect. The draw list makes such a top-level
entry an isolation group with a `LayerKind::Raster` layer (its `objectBounds`), and
the renderer places it like an effect entry: a world-aligned grid anchored at the
bounds, at `rasterResolution` of the view (the scale rounded up to a quarter octave),
within the raster budget and texture limit (not the effect surface's 3,968-pixel cap,
which applies only to artwork with effects), cropped to the screen, composited
bilinearly. An entry with effects is an effect entry (`LayerKind::Entry`) as before.

### GPU (`styk-render`)

One shader and its instance attributes and float textures, as before (D8). A list
with faces gets, per pass, a multisampled `depth24plus` buffer (the editor's mesh
raster format) and two pipeline variants of the same shader: *flat*, which draws
every record in painter order and writes depth (a reset writes the far depth 0.9999
over its rectangle, so each run starts afresh), and *faces*, which tests
`less-equal` and writes. A pass draws its records in one instanced draw, split where
faces begin and end. The vertex shader maps a face corner's depth to its window depth
itself, with the editor's expression, so faces that nearly share a plane (a receiver
over a stock, 2.8e-7 apart in a range of 4.8: about one step of the depth buffer)
resolve where they resolve in the editor. A list without faces draws exactly as
before: one pipeline, no depth buffer, no extra draw call.

### CPU (`styk-raster`)

As on the GPU ([rendering.md](rendering.md#cpu-styk-raster)): raster entries are drawn on
the editor's grid at its density and resampled; a run's reset sets the far depth over its
quad; each face is drawn over the target sample by sample (four at the GPU's standard
positions, one at the centre for crisp edges) where its window depth, interpolated exactly
from the snapped vertices and stored at 24 bits, is not greater than what the run drew there.
Faces nearly in one plane (a few steps of the buffer apart) can still resolve differently
from a GPU, whose own vertex arithmetic decides them.

## Parity

**Geometry** (`styk compare` against `engine/tools/reference.mjs`, which now dumps each
evaluated mesh once per tick and every surface's depths; the comparison checks faces
and palette entries exactly, vertices within `parity::TOLERANCE`, depths relative to
their size, colours, bounds and depth ranges):

| Files | Ticks compared | Primitives | Joints | Mismatches |
| --- | ---: | ---: | ---: | ---: |
| All 175 `.styk` scenes of `AssetReleases/` (every 3rd tick, at most 40) | 3,215 | 92,332 | 323,521 | 0 |
| All 183 `.stkz` figures and `.stykmov` clips of `AssetReleases/` | 183 | 4,627 | 7,608 | 0 |
| `15-Guns-Pivot-3D.styk` (every tick) | 6 | 169 | 1,958 | 0 |

**Fixtures** (`engine/tools/spatial-fixtures.mjs`, `tests/spatial.rs`): 14 projects built
with the editor's commands (meshes authored as the asset builders author them and
converted by the editor's own converter): native skin surfaces, surfaces under
perspective and clipped at the near plane, the Box solid's one-sided faces, skinned
and blended meshes, proportions, perspective and near clipping, eight-view vertices,
splitting by other primitives, mirrored and recoloured instances, mechanical joints
and a hidden expression, a mesh on a layer sheet, a mesh inside a movieclip, attached
clip meshes (bone-owned with views and turns, near-clipped; flat, mirrored,
recoloured, translucent), drawings a head bone turns (two forms of eight directions at
three tilts, a form picked with the drawing control, mirrored, in perspective). Every
fixture matches; each stops matching without its
meshes, its surfaces or its 3D poses, and without the part it is about (view
targets, blended vertices, the depth-order offset, splitting primitives, instance
palettes, reflection, mechanical joints, the hidden expression, depth guides); three
reach the near-plane clip. 120 recorded `interpolateSpatialPose` results match bit for
bit. Records: 512 recorded ticks of every editor-built fixture are produced and
byte-identical, 102 of them spatial (34 with a tweened 3D pose).

**Renderers**: a scene with a depth run, a later record and a second run holds the GPU
and the CPU to the same pixels (`styk-render/tests/depth.rs`, `styk-raster/tests/depth.rs`);
the GPU test is skipped where no adapter exists. Engine GPU against engine CPU
(`styk raster-parity`, D13): twelve frame starts of each of the 180 3D documents pass at
320×192 (1,244 of 1,244), 512×288 (1,242) and the canvas size (1,231), the failures solid
pixels where near-coplanar faces meet ([rendering.md](rendering.md#measured)).

**In the app** (measured against the editor's renderers while they could be compared, rule D13): see [Measured](#measured).

## Differences from the JavaScript, on purpose or known

- No memoization: the editor reuses a pose's previous mesh evaluation and the
  artwork of an unchanged signature; the engine caches whole frames.
- Raster entries follow the editor's raster density for the view, its grid and its
  budget, but not its raster cache: the engine draws the entry for every frame (no
  stand-ins while navigating, no retained sharper raster).
- Invalid meshes are left out and noted where the editor refuses the file.
- Faces nearly in one plane resolve by each renderer's last bits (on a GPU, its own vertex
  arithmetic): the CPU rasterizer and a GPU can pick different faces there.
- The editor lowers raster densities when a scene exceeds its preview budget
  (`previewRasterScale`); the engine does not (as for effects).

### JavaScript behaviours reproduced that look wrong

- **A mesh inside a movieclip does not follow its instance.** The editor places a
  clip's points, starts and ends at its instance; a mesh drawable has none of them, so
  its faces stay where the clip's own frame evaluates them, whatever the instance's
  position, rotation or scale (fixture `mesh-in-movieclip`, test
  `a_mesh_inside_a_movieclip_does_not_follow_its_instance`). Reproduced.
- **Near-coplanar faces** resolve by single-precision rounding of the editor's depth
  expression (the stock and receiver of the catalogue's rifles, 2.8e-7 apart): the
  editor's WebGPU renderer shows the receiver, its Canvas 2D fallback's WebGL 2
  compositor the stock. The engine computes the expression where the WebGPU renderer
  does and shows the receiver on every backend.

## Measured

Measured 2026-10-03 on the development machine (Ryzen 5 5500, RTX 4070 SUPER).

**The gate.** Of the asset catalogue's 358 native files, the engine drew 16 before
(334 were refused for 3D meshes or surfaces) and draws 349 now; 9 keep generated
effects. In `~/Downloads`, Pistol-3D.styk is drawn too.

**App parity, Electron** (engine WebGPU against the editor's WebGPU renderer, D13;
five ticks with onion skins unless noted; run headless under Xvfb with Chromium's
Vulkan switches, the same harness with three extra launch arguments):

| Document | Steps passing | Largest difference |
| --- | ---: | --- |
| Karate-Fighter-Movement.styk (fit, 0.3×, 3×, after playback) | 16 of 16 | 25 levels at 0.3×, ≤ 6 otherwise |
| Karate-Fighter-Turntable.styk, Katana-Turntable.styk | 5 of 5 each | 3 levels |
| Pistol-3D.styk (private corpus, one tick) | 1 of 1 | 1 level |
| fixtures mesh-perspective, clip-mesh, mesh-instances | 5 of 5 each | ≤ 14 levels, mean 0 |
| fixtures surfaces-perspective, surfaces-skin, mesh-split | 5 of 5 each | ≤ 62 levels along edges, mean ≤ 0.07 |
| 15-Guns-Pivot-3D.styk | 0 of 5 | mean rule only, in the captions |
| Hand-and-Face-Pivot-3D.styk | 2 of 5 | mean rule, in the captions (4 solid pixels: a caption's "0") |
| Vehicles-Pivot-3D.styk (fit, 0.3×, 3×, after playback) | 7 of 16 | mean rule and ≤ 5 solid pixels, in the captions |

Every failing step was inspected. The three catalogue scenes carry large captions:
measured by region, their 3D parts differ by 0.00–0.17 levels beyond the quantum
with no solid pixel (15 Guns 0.08–0.12, Vehicles below 0.01 off the cover page),
their captions by 0.4–1.7. The same 15 Guns scene with its meshes removed fails the
same way (ticks 0 and 3: mean 0.76 and 0.41 against 0.75 and 0.41 with them): text
drawn as vector glyphs against the renderer's object rasters, not 3D. Text is now drawn
as the renderer draws it ([rendering.md](rendering.md#text)), with these scenes' results.

**App parity, web target** (engine WebGL2 on SwiftShader against the Canvas 2D
fallback): Karate movement, Katana turntable, Pistol-3D and the fixtures
mesh-perspective, clip-mesh, surfaces-perspective and mesh-split pass every step
(mean ≤ 0.12). 15 Guns fails (mean 0.48–0.85; tick 5 has 87 solid pixels on the
rotated Warden, where the Canvas fallback's WebGL 2 compositor shows the stock over
the receiver and the WebGPU renderer, like the engine, shows the receiver: the
editor's two renderers disagree on these nearly coplanar faces).

**Cost** (`styk bench`, `styk gpubench` at 1,440×900; three rounds each).
Before and after on the same files, interleaved (load 10–12 from other work):

| File | | Evaluation | Draw list | GPU frame p50 |
| --- | --- | ---: | ---: | ---: |
| Jay on a new app (repaired), no 3D | before | 1.08 ms | 0.26 ms | 0.26 ms |
| | after | 0.99 ms | 0.25 ms | 0.27 ms |

The 3D scenes now (load 4; before the port the engine did not evaluate their 3D):

| File | Evaluation | Draw list | GPU frame p50 | Draw-list records |
| --- | ---: | ---: | ---: | ---: |
| 15-Guns-Pivot-3D.styk | 0.22 ms | 0.58 ms | 0.23 ms | 14,690 records |
| Hand-and-Face-Pivot-3D.styk | 1.03 ms | 0.42 ms | 0.26 ms | 21,590 records |
| Karate-Fighter-Movement.styk | 0.59 ms | 1.12 ms | 0.22 ms | 11,971 records |

GPU memory with 3D at 1,440×900: 29.7 MiB of layer atlas and depth buffer (19.8 MiB
of it the multisampled depth buffer of the layer pages); none without 3D.

## Open

- The web target's JavaScript renderer is the Canvas 2D fallback, which draws depth
  runs through a WebGL 2 compositor at the context's scale with a resampled tile grid;
  the engine draws them like WebGPU devices there.
- **Editing**: `styk-edit` answers `Unported("geometry with 3D")` for documents with
  3D (`spatial::document_has_3d`) until a command replay covers editing them; the
  editor's 3D commands (`setSpatialPose`, `setSpatialCamera`, proportions, mechanical
  joints, pose choices, the spatial gizmo) are not ported.
- **Draw-list cost**: each face is a 64-byte record (1.1 ms per frame to encode the
  Karate fighter's 12,000 faces); an indexed form would encode and upload less.

## Changing it

- **A new mesh or surface field**: read it in `spatial.rs` (`MeshPlan::compile`,
  `ClipMesh::parse`, `parse_surface`, `parse_pose`), evaluate it where the editor does,
  add a fixture to `spatial-fixtures.mjs` that fails without it and a dependency check
  in `tests/spatial.rs`.
- **A change to the editor's 3D arithmetic**: change the JavaScript first, regenerate
  the fixtures (`node engine/tools/spatial-fixtures.mjs`, `records-fixtures.mjs`), then
  make the engine match. Keep `styk-math` in the spatial path.
- **Depth drawing**: the format is `styk-draw`'s (`K_DEPTH_RESET`, `F_DEPTH`,
  `window_depth`); GPU and CPU must keep passing the shared depth scene.

## Testing

```sh
node engine/tools/spatial-fixtures.mjs        # tests/fixtures/spatial/ (byte-stable)
node engine/tools/records-fixtures.mjs        # tests/fixtures/records/, spatial fixtures included
cd engine && cargo test -p styk-eval --test spatial --test records
cargo test -p styk-render -p styk-raster --test depth
cargo build --release -p styk-cli
node tools/reference.mjs <file.styk> /tmp/ref.json --every 1 && target/release/styk compare <file.styk> /tmp/ref.json
target/release/styk render <file> <tick> gpu.png && target/release/styk raster <file> <tick> cpu.png && target/release/styk diff gpu.png cpu.png diff.png
npm run engine:parity -- --corpus             # adds the catalogue's 3D scenes, every tick
```
