# Spatial meshes

## Figure meshes

A figure can store one immutable indexed mesh in `_styk.spatialMesh`, bound to
its own articulated spatial bones (docs/RIG-CONSTRAINTS.md). Vertices are
definition data: they are not joints, fills or per-frame pose channels. A 3D
character therefore keeps tens of bones in its joint graph and pose records,
whatever the density of its surface.

| Field | Contents |
| --- | --- |
| `positions` | Bind-space XYZ per vertex, in the coordinates of native skin points. |
| `bones`, `weights` | Four slots per vertex: spatial bone IDs (0 = unused) and weights that sum to one. |
| `indices` | Three vertex indices per triangle, front-facing with the reference parity. |
| `colors`, `materials` | An RGB palette (up to 1,024 entries) and one palette index per triangle. |
| `basis` | Origin, X and Y reference joints, as for one-sided native fills. |
| `z` | Optional depth-order offset of every face. |
| `views`, `viewVertices`, `viewPoints` | Optional four- or eight-view targets for single-bone vertices, with the semantics of view-corrected skin. |
| `groups` | Optional named, ordered triangle ranges, such as "Mask" or "Left boot". |

Validation bounds vertices (200,000), triangles (400,000), palette size and
coordinates, requires every binding to name an articulated spatial bone and
rejects degenerate or out-of-range triangles. Native STYK/STKZ containers store
the flat numeric arrays in their binary sections.

A pose evaluates the mesh once, after its bones, in `src/spatial-mesh.mjs`.
Skinning follows rig-spatial skin points operation for operation: single-bone
vertices use the bone frame, including stretch, part proportions and pose
choices; several bones use dual-quaternion blending, or a linear blend while any
bone stretches; view targets blend around the bone heading. Vertices then take
the figure rotation, scale, reflection and optional perspective. Faces are
culled by the reference parity with the native edge-on tolerance and clipped
against the perspective near plane. Positions and depth are typed arrays with
native Float32 rounding. An unchanged pose, including colours, returns the
previous evaluation. Translation alone re-evaluates positions, but the artwork
signature is root-relative, so rendered artwork is reused.

The figure's Colors palette includes mesh colors. Per-instance recoloring uses
the existing style override with bounded `_stykStyle.meshColors` palette-index
RGB values, retaining the immutable mesh, skin weights and compiled plan.
Color-only edits reuse evaluated vertex and triangle arrays and follow normal
undo, native saving and timeline property behavior.

The evaluated mesh is drawn as depth-tested triangles in one pass. Other visible
primitives of the figure split its faces only where native per-face painter
order would; zero-width construction lines do not. WebGPU renders mesh-only
objects directly into their object texture with a depth buffer, both while
editing and when a playback packet is prepared: workers send the evaluated
arrays instead of pixels. Canvas rendering, exports, figures with effects and
nested or partly transparent clips use the shared WebGL2 depth compositor
(software without WebGL2). Onion tints recolour every face.

Build Figure keeps mesh bones and reference joints: deleting one is rejected, as
are branch copies, figure combination and origin changes, which would require
rebinding. Definition snapshots and history share the immutable mesh. Pivot
.stk/.piv export rejects meshes, like other one-sided fills; images and video
preserve their appearance.

`src/spatial-mesh-legacy.mjs` converts native skin joints used only as vertices
of opaque, front-facing depth-tested triangles into a figure mesh. Every other
joint keeps its ID; objects lose only the removed joints' pose channels.
Figures whose skin joints are also parents, rig anchors, join or IK targets, or
vertices of other fills keep the native representation, which remains
supported. `node scripts/convert-spatial-meshes.mjs <input> <output>` converts a
STYK or STKZ file without modifying the input.


## Attached movieclip meshes

A movieclip definition can store immutable indexed `spatialMeshes`, one per local
frame. Each mesh has flat XYZ `positions`, triangular `indices`, RGB `colors`, and
one palette index per triangle in `materials`. The existing single-frame playback
offset and named drawing groups select forms. `drawingRotation` is mutually
exclusive: turning a mesh never switches drawings or interpolates silhouettes.

An attachment to a spatial bone evaluates its vertices through that bone's
existing spatial frame, then applies figure transforms and perspective. The bone
alone owns the attachment's orientation: the attached object's own angle, which
Pivot-style joins rotate along with a bending parent, is not applied again. Rotation,
tilt, roll, stretch and part proportions stay in the rig's existing pose channels.
Only the container handle belongs to the editable joint graph. Geometry is authored
offline; entering an empty movieclip editor is rejected with posing guidance.

The geometry evaluator produces the same typed record as a figure mesh: visible
triangles with depth, drawn as one depth-tested mesh drawable by the same GPU
raster and compositor. Near clipping, worker preparation and rendered exports use
that path. Evaluation yields within dense meshes. Incremental geometry retains the
typed arrays when the attachment transform is unchanged, and rebinds colours
without retaining the previous geometry. The numeric transform key of that pose
is also its root-relative artwork identity; there is no second render cache.
Affine bone transforms are evaluated four times per mesh rather than once per
vertex; non-linear taper keeps the existing point evaluator. Palette colors
use the normal object color override. Immutable mesh arrays are shared by definition
snapshots, as clip documents are, rather than cloned into every history entry.

A mesh may add `viewPositions`: four or eight complete position arrays with the
same length and vertex order as `positions`, authored for headings 0°, 90°... or
0°, 45°... of the attachment bone (slot k faces turn k×step). The evaluator blends
the two sets around the bone's current heading with the same smoothstep and
vertical fade as view-corrected skin, then applies the
ordinary bone, figure and perspective transforms. Topology, indices, palette and
draw order never change; looking straight up or down uses `positions`. This is
art direction in the style of per-camera model adjustment: it lets an attached
head keep its drawn silhouette in every direction while turning continuously.
View sets count toward the geometry budget and are shared immutably like the
rest of the mesh.

Optional `viewTurns` (one angle per view set, within ±180°) and `viewPivot` add a
turn about the pivot's vertical axis for each heading. Turns are interpolated
along the shortest arc and applied after position blending, so a shape that
must face the viewer differently in neighbouring views rotates instead of
shrinking through a linear average. Optional `viewTurnWeights` (one 0–1 value per
vertex) scale that turn per vertex: an attached head can keep its skull and face
turning with the bone while its hair holds a drawn design toward the viewer, as
reference turnarounds often do. Weights require `viewTurns`.

Native STYK/STKZ retain the indexed mesh. Explicit Break apart/Bake and legacy
materialization convert the evaluated visible faces into ordinary native fills
with depth guides; this is intentionally more expensive and loses 3D editability
for that baked pose. It is never used during dragging or prepared playback.

Validation bounds form count, coordinates, vertices, indices, palette entries and
total asset geometry. Mesh winding is outward in local XYZ; front-facing triangles
have positive screen area before reflection. Shapes and texture detail must be
authored and visually checked; format validation cannot establish reference likeness.

`tests/movieclip-mesh.test.mjs` covers invalid assets, reflection, perspective,
near clipping, both timeline modes, form undo/redo, native round trips, immutable
history sharing, and materialization. It compares incremental poses with fresh
evaluation throughout full turns and vertical tilts, and checks that view-corrected
meshes reproduce every authored heading, blend between them, fade near vertical
views and interpolate per-view turns as rotations.
