# Connectors and Smart Stretch

Native rig relationships are available in Build Figure. Animation uses the same
editable joints, frame channels, undo history and renderer as ordinary figures.

## Build and pose

**Connectors:** select a joint and choose **Connect joints** in Properties or
the builder Edit menu, then click the other anchor. Alternatively Shift-select
two joints and choose Connect joints. Escape cancels picking. The connector spans
both anchors, even when they belong to different branches. Its own joint is a
real sliding attachment: drag it or enter **Slide position** (0–100%). Draw parts
from that joint, join another figure to it, use it as another connector's anchor,
or include it in a polygon. Anchor Pick buttons reconnect an existing connector.
Curved connectors retain both anchors and slide along the curve.

**Weighted joints:** select an anchor and choose **Add weighted joint**. The new
joint starts halfway between the selected anchor and its parent. Its inspector
sets an origin and up to 16 distinct anchors with signed weights. The position is
the origin plus the weighted offsets from that origin; two weights of 0.5 blend
two anchors, while signed weights can combine projected axes. These joints can
drive fills, connectors and attached parts. Move their anchors to pose them.
Their dependencies participate in the same cycle checks, duplication, undo and
native saving as connectors. IK belongs on the driving bones. They add no
animation channels or renderer state.

The diamond handle selects **Slider** controls (position and Static). **Segment**
contains the connector artwork and rig setup. Selected sliders show dotted A/B
guides to their anchors in Builder and Animate. These are editor guides only;
colors and width still belong to the segment. Connecting an existing parent and
tip creates another segment that may overlap the original artwork.

**Smart Stretch:** build the attached parts, select their controlling joint and
check **Smart Stretch**. This enables the driver and binds its descendants in one
undo command, including subsequently drawn parts automatically. Another enabled
ordinary driver starts a separate scope. Select an affected detail and choose
**Keep rigid · pass through** to move it without changing its size.
Ordinary drags rotate at the current length. **Hold Ctrl while dragging to
stretch** (Command also works). Moving a figure preserves its pose.

Enabling Smart Stretch captures the current segment length as its rest length,
excluding figure scale. Connectors capture the current distance between anchors.
Stretch settings contain rest length, minimum/maximum ratios and width response.
Affected parts expose a signed linear **Multiplier**, **Reset impulse here** to
restart the axis at that joint, and **Stop at this joint** to protect a branch.
Attachment settings retain explicit driver picking and legacy influence/orientation.
**Angle lock** supports Figure, Movable parent and World references, with a signed
rotation multiplier for the parent mode. Locked drags preserve the angle; edit
**Locked angle** to change it. These controls support projection and mechanical
constructions across branches.
**Apply angle lock → Before stretch** follows the reference's authored angle and
then projects the vector through Smart Stretch. **After stretch** remains the
default for existing rigs. Before-stretch followers keep surface vertices on a
rotating joint even when its projected angle reverses or collapses. Ordinary
fixed-length posing at a fully compressed view preserves the current bend branch;
stretching still requires expanding that view first.
Disabling a driver removes its follower bindings atomically; Undo restores them.

A connector's span is determined by its anchors. Its Smart Stretch source can be
**Anchor distance**, **Slide position**, or **Distance × slide**, combined with an
inherited impulse when present. Limits constrain attached parts and never disconnect
the endpoints. Its middle joint still slides. For new automatic drivers, curvature
alone does not change distance-driven stretch. Older span responses remain intact.

Setup controls and blue relationship guides are confined to Build Figure.
Animate retains ordinary handles and the selected connector's Slide field.
**Test rig** opens an isolated temporary editor: drag controls, select named
controls, enter angle/length/slide values, Fit view or Reset test. Closing the test
preserves the live definition, animation and undo history.

## Spatial articulation and posing

A native spatial construction uses ordinary angle channels for three-axis joint
rotation. Parent transforms, rest origins, rest tips and up to four skin weights
are definition data in `_stykRig.spatial`. Individual skin vertices are native
joints; a dense surface is a figure mesh bound to the same bones, whose vertices
are definition data rather than joints (docs/SPATIAL-MESHES.md). Dual-quaternion
blending preserves volume through twists;
axial stretching uses weighted transformed positions. Derived depth participates
in the existing surface evaluator and renderer. There is no additional animation
clock, pose store or renderer scene graph.

Authored single-bone skin can optionally provide `viewPoints`: four or eight finite XYZ
positions relative to the binding's rest origin, ordered in equal turn steps
starting at 0 degrees (90-degree or 45-degree spacing). Each target uses the
frontal axes of that view. This supports art-directed silhouettes on solid clumps without changing topology or blending
drawings. The composed bone orientation selects adjacent targets; smoothstep
interpolation wraps continuously at 360 degrees. The inverse heading transform
then retains physical tilt and roll. Near a vertical viewing direction, where
heading is undefined, correction fades smoothly to the ordinary rest position.
Stretch, shape, figure reflection and perspective follow the existing pipeline.
Multi-bone skin cannot use view targets.

Targets are definition data saved and remapped with the skin, driven by ordinary
turn/tilt/roll animation channels. There are no extra animation tracks or controls.
The interpolation frame is computed once per evaluated bone and retained only in
that pose's derived geometry. Definition changes invalidate it through the normal
rig plan; undo, native round trips and fresh/partial evaluation use the same path.
Targets require authoring and visual review at intermediate turns and tilts;
interpolation alone does not guarantee a nonintersecting or accurate silhouette.

In Animate, **Pose** uses the ordinary joint markers. Hand and foot endpoints
use the existing IK settings. Dragging a free spatial joint turns the bone flat
on screen, as on an ordinary figure: it rotates about the view axis through its
base by the pointer's angle around that base, keeping its lean toward or away
from the camera, its projected length and its twist. Children turn rigidly with
it. Under perspective the pointer is unprojected at the tip's depth, which this
rotation preserves, so the end stays under the pointer. **Ctrl** also scales the
bone's length by the pointer's distance from the base.

Holding **Hold to pose 3D parts in depth** (D by default, rebindable in Keyboard
shortcuts) swings the bone in 3D at constant length instead: its end follows the
pointer, and pulling it inside its projected reach brings it toward or away from
the camera, so arms reach forward, knees lift and the chest leans. The depth
side comes from the bone's current direction, or the character's front when the
bone lies in the view plane. Holding **Shift** as well mirrors it to the other
side (behind the body). Bones shorter than 70 screen pixels (chest, neck, feet)
use a 70-pixel virtual lever for finer control. Pressing or releasing the key
mid-drag restarts the other gesture from the current pose and pointer, so the
bone never jumps; the drag remains one undo step.

Both gestures are relative to where the marker was grabbed, so grabbing beside
it never jumps. **Right-drag** twists the part about its own axis (turn the head,
twist the torso or forearm): 120 pixels of horizontal travel give a quarter
turn. With IK on, the hand or foot marker is that part's control: right-dragging
it turns the hand or foot about the forearm or shin instead. On a planted limb,
right-dragging the knee or elbow swings its bend direction (the IK swivel) at the
same rate while the hand or foot stays planted. Neither releases a pin. On a
spatial hand or foot target, **Shift** or the depth key pushes the target toward
the camera (drag down) or away (drag up) while it stays under the pointer; a
plain drag afterwards continues from the target rather than jumping to the
pointer. Every sample is solved from the gesture's start orientation, so closed
drags return exactly without twist drift.

A plain drag of a spatial hand or foot target with IK solves a two-bone limb
flat, like a 2D figure. The knee or elbow moves across the screen rather than
toward the camera: the upper bone keeps its depth lean (knee minus hip depth),
and the target keeps its depth, so the lower bone keeps its lean too, and both
keep their projected lengths. The knee stays on its side of the hip–target line
on screen. A straight limb bends to the side its stored bend direction shows on
screen, or else to the side the pointer first leaves the line by.
The engine (`styk-edit` `spatial_ik.rs`) computes that knee, which is stored
only as the controller's pole for the existing analytic solver, so playback,
planting, undo and saving are unchanged. A limb pointing straight into the
screen keeps its stored pole.

Use **Rotate** for exact turn/tilt values. Rotate shows local X/Y/Z rings, a free
trackball and an outer view ring; Shift gives finer movement. Whole body, limb,
torso and belt-tie shortcuts select native joints. Each drag is one undo step;
Escape cancels it.

Each hand and foot has an **IK** switch in the rig panel. With IK off the limb
is posed joint by joint: dragging the hand or foot turns only the forearm or
shin, flat on screen. Switching IK back on captures the current pose without pinning it.
A disabled spatial limb keeps its controller record (with `enabled: false`) so
the switch stays available; solvers ignore disabled controllers.

**Plant both feet** retains foot position, depth and orientation while the hips
move; **Release feet** lets the character move. Drag a planted knee or elbow's
ordinary joint marker to steer its existing bend plane while its endpoint stays
planted. Pose does not draw separate IK targets, pole diamonds or depth handles.
**More limb options** contains Bend direction, Target depth and Stretch; these
remain available for free and planted limbs. **Pinned** stays visible.

The **Turn / tilt** pad adjusts two rotation channels in one gesture; arrow keys
step five degrees (one with Shift). **Exact angles** exposes the same native
channels numerically. Rotating a constrained thigh/shin or upper/forearm bakes
the displayed pose and releases only that limb, so its foot/hand follows.
Rotating a planted foot, from Rotate or by dragging, right-dragging or depth-dragging it
in Pose, updates its stored orientation. Body/pelvis turns keep
other targets planted. The lower torso remains independent of the pelvis.

Live object-pose edits reuse evaluated spatial branches and fills whose numeric
inputs and dependencies are unchanged. This reuse requires the editor's explicit
pose-only invalidation; definition edits and replacement objects rebuild normally.
Global transforms/appearance invalidate evaluated records. Polygon dependencies
include winding bases and depth guides, even when they are not visible corners.
The derived cache belongs to published geometry through a WeakMap and never
retains a predecessor scene; ordinary worker builds avoid compiling unused fill
dependency tables. Cancellation, undo and fresh evaluation remain equivalent.

Spatial bones may expose mutually exclusive named poses with segment metadata
`_stykPoseChoice: {group, label, shown, hidden}`. The two numbers are finite native
lengths, not another pose store. Each group becomes one inspector selector with
a Hidden option. Changing it sets the selected bone to its shown length and the
others to their hidden lengths in one undoable edit. Intermediate channel values
display as Custom pose. Names and lengths are validated on import; the metadata
contains no external joint references, so ordinary duplication/remapping retains
its meaning. This supports optional expression geometry that collapses inside a
head at zero length and uses the existing surface depth, saving and playback.
Choices whose hidden length is zero scale bound geometry in all three axes, so
hidden expressions have no visible area at any viewing angle. Ordinary spatial
bones continue to stretch only along their axis.

A spatial figure may also store definition-only `_styk.poseChoices` groups:
`{name, choices: [{id, label, angles: [[jointId, restDelta]],
lengths: [[jointId, nativeLength]]}]}`. Each choice writes the same bounded set
of existing channels for its group in one undoable edit; it never swaps meshes.
Angles are relative to the native rest angles and retain the instance's figure
rotation and reflection. Selection is derived from those channels, with Custom
pose after fine edits. These groups have no Hidden option. Definitions validate
every referenced bone/rotation channel, complete group channel sets and finite
values; deleting a referenced control fails atomically. Native saving, duplicate
figures and timeline interpolation preserve the ordinary pose channels.

Dynamic controls with `_stykControl: {level: 'detail'}` keep their normal posing
behavior but hide their canvas markers until **Detailed controls** is enabled.
Choosing one from Articulation reveals its marker individually; Builder and
joining also expose them. This checkbox is editor presentation state, not an
animation channel or an undo step.

Mechanical joints keep a part on a fixed track, such as a pistol's slide and
trigger. A spatial bone with `motion: {type: 'slide' | 'hinge', min, max}` is
rigid. A slide moves along its rest origin-to-tip direction, carried by its
parent; its native length channel stores rest length plus travel, clamped to
`min`–`max` figure units. A hinge turns only about its configured axis through
its origin, from its ordinary angle channel relative to its parent, clamped to
`min`–`max` radians. Optional `axis: [x, y, z]` gives a unit hinge axis in the
parent's local rest coordinates; omitting it retains the depth axis `[0, 0, 1]`
used by existing gun mechanisms. Their turn and tilt channels are ignored, and
neither their skin nor their children stretch. In Pose, dragging a mechanical joint moves it
to the point of its track nearest the pointer, relative to where it was grabbed,
stopping exactly at either end. Rotate and Turn/tilt change only a hinge's angle
and leave a slide unchanged. The rig panel shows a Slide or Hinge field as a
percentage of travel; Reset returns it to rest. Rotate shows only a hinge's actual
axis ring and leaves a slide unchanged.

A mechanical motion can add `driver: {joint, multiplier}`. The driver must name
another spatial mechanical bone, and the finite multiplier is bounded to −10…10.
Its already clamped travel is multiplied and added to this joint's ordinary
angle or length residual before this joint's own final limits. This supports a
single curl control driving several finger joints while every joint retains fine
posing, and small cheek or nose motions driven by a mouth or eyelid control.
The dependency graph rejects cycles, remaps the driver during duplication, and
invalidates driven geometry during pose edits. Native cumulative angle channels
are decoded relative to the authored parent angle, so a driven parent cannot
cancel a child's independent residual. The mechanical inspector edits that
residual with a range shifted by the current driver contribution; negative fine
adjustments can relax a curled finger without bending it backwards. Canvas drags
and the hinge ring use the same limits, gesture undo and cancellation. These
controls are FK tracks, rather than unconstrained three-axis finger IK.

No channels or persistent evaluator state
are added: figure meshes, playback, undo and native saving use the same
channels. Mechanical joints are authored in definition data; Build Figure cannot create them yet, and earlier
versions reject files that contain them.

Spatial IK evaluates only the driving dependency closure, excluding skin vertices
from solver iterations. Two-bone spatial chains in one figure use an analytic
3D solver with persistent target depth and a knee/elbow pole when bend direction
is Automatic. Other chains and explicit planar bend directions retain the
projected solver. Optional `spatialTarget` metadata stores depth, a world-space
unit pole, a swivel angle and optional two local unit `normals` defining the
captured bend plane; `spatialFollowers` and `joinedSpatialFollowers`
store unit quaternions relative to target rotation. Native interpolation uses
short-arc rotation interpolation. Ordinary limbs retain the planar solver.
Joined figures preserve their original control reference spaces in virtual chains.
The analytic solver aligns each bone axis and captured plane normal directly,
instead of accumulating shortest-swing rotations from previous samples. Free
target drags retain one captured reference for the gesture. This avoids axial
twist drift on closed drag paths without adding a second animated skeleton.

Spatial bindings are currently authored in native definition data. Build Figure
cannot reposition their rest joints, reparent bound bones, mirror an individual
bound branch or combine the spatial assembly into a flat definition: those actions
would require rebinding the skin. Figure-mesh bones and reference joints cannot
be deleted. Whole-figure reflection, posing, native saving, undo, playback and
joined assemblies remain supported.

Attached movieclips may expose named drawing sets. Form and view selectors choose
existing single-frame playback offsets, including through the Advanced timeline.
The head drawing remains discrete; selecting a drawing creates an ordinary
undoable pose edit and retains the body selection.

Attached drawing banks may opt into stepped rotation with
`drawingRotation: {steps, tiltThreshold}`. Each form contains exactly three rows
of `steps` views: level, up, down, ordered from front around a full turn. A
joined spatial bone selects the nearest direction and switches tilt at the
specified radian threshold. Its composed orientation uses native angle hints
to keep equivalent Euler branches stable at side and back views. The drawing
is anchored to the bone origin and follows its roll; no drawing interpolation
or hidden 3D head geometry is used.

The existing single-frame offset chooses the form. Only the selected drawing
is evaluated through the bounded movieclip cache. Derived selection lives in
geometry, not saved document state; direct posing, workers, seeking, reverse
playback and explicit materialization share it. The Form selector appears above
body controls. Existing manually selected drawing banks remain unchanged.
Rotation-driven drawings support the spatial parent's perspective: their anchor
and scale use its depth projection. Other joined drawings retain their existing
orthographic restriction. Body rotation, articulation and IK are unchanged.

Whole-character orientation uses **Rotate figure** in the Character rig inspector.
It rotates the root spatial articulation and carries existing spatial targets,
bend-plane directions and foot/hand orientations around that pivot. Pin states
are preserved. Local torso articulation continues to leave targets planted.
**Move figure** selects the ordinary translation control; **Pose** retains direct
joint dragging. No separate animated rotation state is stored.

Spatial canvas drags and root moves with planted targets keep only the latest
pending pointer sample. The existing render loop applies it before drawing;
release flushes it before committing, and cancellation discards it. Paint and
construction gestures keep their original input paths. Published spatial geometry
owns reusable definition and rig plans; only the editor's certified pose-only
invalidation can carry them into another geometry. Other definition changes and
history replacement continue to validate topology.

Free spatial IK targets retain the ankle or hand articulation relative to the
solved shin or forearm. Planting captures world orientation; direct chain rotation
releases only that limb. The inspector offers direct limb-joint rotation shortcuts
without introducing additional pose state.

### Perspective and artistic proportions

**Perspective** in the Character rig inspector is optional and starts at zero.
Increase its strength, then use **Toward camera** on a hand/foot target to bring
the limb forward. Smaller camera **Distance** increases foreshortening. Depth
movement follows the cursor's view ray; reachable targets keep their screen
position while their surrounding mesh grows or recedes. Ordinary reach limits
still apply; **Stretch** remains an explicit choice. **Center on figure** aligns
the camera with the current root. Its center then stays fixed when hips move,
so a planted foot does not slide. Figure Scale provides shot framing.

**Shape** identifies the selected articulation. **Part size** scales its native
length, radial width and descendant bones together (for example, ankle and toes).
**Length**, **Width** and **Taper** adjust that bone locally. Positive taper widens
the tip with a smooth transition along the bone. Zero-length root controls use
figure Scale instead of length/part-size controls. **Reset this bone's shape**
restores that bone's original length, width and taper; child settings are retained.
All controls use the existing pose keys, native saving, undo and gesture cancellation.

The optional object field `_stykSpatial` contains `camera` (strength 0–1,
distance 10–100000 in unscaled figure units, scene-space centerX/centerY) and
`shape`, keyed by stable bone ID, with width 0.1–5 and taper −0.9–3. Missing values
use orthographic projection and original proportions. Native lengths remain the
sole length channels. Pose interpolation blends these values, including neutral
endpoints; Tweener push clamps extrapolated values to their valid ranges.
Topology transactions remap/prune shape references.

IK and its persisted targets remain in pre-projection scene space. Perspective
is applied once after skin deformation; pointer inputs are unprojected at the
target's depth. With k = strength / (distance × instance scale), projection uses
1 / (1 − k × depth). Depth-tested triangles clip at denominator 0.05 and use
depth / (1 − k × depth), which interpolates correctly in screen space. Clipped
convex quads share the same fan triangulation in GPU and software rendering.
Camera changes invalidate projection; width/taper changes invalidate only their
rig dependencies. Perspective root movement must rebuild projection and cannot
reuse a uniform artwork translation. No renderer or playback clock is added.

Perspective currently applies to a single spatial figure. Separately joined
figures/drawing banks retain their existing orthographic projection; enabling
perspective on them or joining an active perspective figure is rejected before
publication. This avoids mixing projected attachment roots with unprojected IK.
Part proportions remain available on ordinary joined spatial constructions.

## Editable 3D constructions

Open **Library → Rig examples**, or **Build Figure → Edit → Rig examples**.
Click a preview to try its controls, or **Add** to insert it directly.
Add to Animate works from either workspace: it keeps current builder changes,
switches to Animate, adds an independent editable copy, selects its primary
control, opens Properties and frames the selection. One Undo removes the added
copy while retaining the previous construction. Locked or hidden destination
layers show an error before leaving the builder.

Library preview windows also offer **Add to Animate**, retaining the angle, length
and slider values tried in the temporary editor. Closing a test without adding
still leaves the live scene unchanged. Static construction details remain
editable in the builder; only useful controls appear in animation and testing.

| Rig | Live construction |
| --- | --- |
| Counter-rotating gears | Drive turns a second wheel through a −1 parent angle lock; both axles stay fixed |
| Folding fan | Open drives nine ribs through fractional rotation multipliers, with connected filled leaves |
| Accordion screen | Fold alternates panel directions; Depth projects the width vectors while uprights remain rigid |
| Expanding crate | Expand widens the front while −1 stretch and impulse resets retract the receding edges |
| Perspective conveyor | Travel drives connector slide stretch; negative multipliers and corner resets shrink the moving frame toward its vanishing point |
| Box, Cylinder, Wedge, Pyramid, Gem | Five opaque solids with full yaw rotation, depth compression, height and individual colored faces |
| Glass cube | Eight projected corners, connected faces and a bead sliding along a moving diagonal |
| Meridian globe | Latitude and meridian connectors sharing projected vertices, with a highlighted equator |
| Double helix | Two rotating strands, connected rungs and a sliding rung attachment |
| Perspective tunnel | Sliding cross-sections on a depth span, connected wall panels and a nested dolly attachment |
| Orbital gyroscope | Three independent projected hoops, rotation controls and rigid orbit markers |
| Turbine assembly | Eight rotating blade faces inside a fixed connected cylindrical housing |

All sixteen examples use ordinary joint Angle, Length and connector Slide
properties, including in the gallery's isolated preview. There are no custom
sliders, artwork-drag rotation handlers or grouped color controls. Each face has
its own ordinary editable color. The city catalogue and assembled scenes remain
removed. Old preset control/shading metadata has no active behavior.

The five opaque solids now use Builder's general one-sided fill property, so all
their construction and appearance settings are available to user-created figures.
Preset identity is optional: removing it leaves evaluated geometry unchanged.
Joint names can be edited in Builder Properties. When drawing from overlapping
joints, the currently selected joint takes priority. Connect joints also accepts
the figure origin as its starting anchor through the Edit menu.

See [Build a rotating cube](ROTATING-CUBE.md) for an exact recipe using a blank
figure, two controls, four radii, eight corners, six fills and twelve connectors.

`node scripts/build-rig-collection.mjs` generates a reusable `.stkz` figure
and an animated `.styk` project per example in `artifacts/connector-3d-rigs/`. Projects are
73 ticks at 24 FPS, including a closing pose. These are editable 2D constructions
producing 3D-style projections. They do not add a mesh engine.

The rotating constructions transfer yaw through a connector whose sliding joint
is at its start. Attached radial vectors inherit that angle. A separate Smart
Stretch driver compresses their depth component. World-aligned vertical offsets
produce corners at `x = r cos(angle + yaw)`,
`y = height + depth × r sin(angle + yaw)`. Every visible edge connects two such
joints. Changing one control recomputes dependent edges and polygons; their poses
are not individually keyed or baked.

Select a fill in Build Figure to choose **Visible sides: Both / Front / Back**.
**Flip facing** reverses its visibility without changing vertex order or curved
edges. The first one-sided fill prompts for **Reference joints**: Origin, X and Y
form an independent, non-collinear triangle. For a rotating solid, ordinary
fixed guides attached to the figure origin provide that triangle. Subsequent
faces reuse the reference, with independent facing. Reference joints remain
editable through the fill's button. Invalid references fail before mutation;
deleting a guide used by surviving fills is rejected. Hidden faces stay available
in the Builder tree; canvas picking selects visible faces.

One-sided polygons store `_stykSurface: {basis: [origin, x, y], side: 'front' |
'back', flipped: boolean}`. Both removes this optional property. Older basis-only
records mean Front. Geometry uses signed area relative to the reference triangle,
preserving facing through mirrors and ID remapping. Collapsed references and
edge-on faces render hidden. The optional **Depth joints** field accepts existing
joint IDs separated by commas. Their mean projected coordinate along reference X,
in units of that reference axis, offsets the fill's ordinary Z-index. Store these
references as `depth: [jointId, ...]` inside `_stykSurface`. Depth guides remap and
remain protected like facing references. Without them the original painter order
is unchanged. For opaque triangular fills, **Depth test intersections** uses one
depth joint per corner, in vertex order, to resolve crossing surfaces per pixel.
Store `depthTest: true` alongside the three `depth` references. Consecutive opaque
depth-tested fills within a figure share a depth buffer; ordinary fills and other
figures retain their painter order. Transparent fills retain painter ordering.
The compositor reuses bounded 1024-pixel tiles and falls back to software depth
testing if its graphics context is unavailable or lost. Native files retain all
editable joints and colors; rendered exports preserve intersections. SVG embeds
the rendered frame as an image when depth-tested fills are present.
Ordinary polygons remain double-sided. Native saving, Canvas, WebGPU, playback
and SVG share the same visibility decision. Pivot export rejects one-sided fills
instead of silently discarding them. Partial branch copies requiring outside
face references are rejected; copying the whole figure retains them.

Gallery thumbnails are generated lazily, one per animation frame, and their
geometry and rendering resources are released.

The solid regression suite checks 1,125 combinations of yaw, depth and height
against convex-hull coverage, plus reflection, whole-figure rotation, individual
face-color undo in both modes, native round trips, combined figures and invalid inputs.
`tests/builder-surfaces.test.mjs` additionally constructs a cube exclusively with
normal Builder commands and checks 1,083 projected poses. Its browser counterpart
creates a connector from Origin, draws from its overlapping attachment, and clicks
all six polygon cycles on the canvas. `tests/rig-solids.browser.mjs` covers ordinary
joint previews, face authoring, reference errors/reuse, reset, isolated previews,
insertion and compact/dark layouts. The renderer
suite compares editable WebGPU, prepared playback and SVG for every example.
The benchmark also compares 100 solid instances with and without surface
culling; see `artifacts/rig-constraints/benchmark.json` for measured CPU times.

## Data and evaluation contract

`src/rig-constraints.mjs` owns the validation of the stored rig; the engine evaluates it (`styk_eval::rig`). Segment `_stykRig`
metadata is optional; unconfigured figures retain the ordinary evaluation path.

```js
{
  connector: {start: 1, end: 2, restLength: 120},
  stretch: {restLength: 120, min: 0, max: 10, width: 'keep', branch: true},
  follow: {driver: 3, mode: 'stretch', influence: 1},
  response: {mode: 'stretch', multiplier: -1, reset: false},
  orientation: 'inherit'
}
```

Fields are optional. A connector cannot also be a follower. References name native
handle IDs (0 is the origin for connector anchors). Connector `length` and the
instance's corresponding length channel store the slide fraction 0–1. Actual
render length comes from its anchors. This retains native interpolation and
avoids a second pose channel or independent control map.

`stretch.branch` enables inheritance through the compiled hierarchy. Automatically
created `follow` entries carry `automatic: true`; their actual source resolves from
the current branch. New parts need no stored binding. Explicit older bindings
retain exponential `influence`; setting `response.multiplier` selects the new
linear response. `response.mode` is `stretch`, `rigid`, or `stop`. A reset redirects
the axis for the current part and descendants without discarding the ratio.

Connector `stretch.source` is `span` (default), `slide`, or `combined`; the latter
two store a nonzero `restPosition` in 0–1. Incoming impulses affect output, not
anchor geometry. `angleLock` stores `{mode, angle, multiplier}`; `figure` also
stores `restAngle`, while `parent` stores `reference`, `restAngle` and
`figureRestAngle`. The latter keeps whole-figure rotation outside the parent's
rotation multiplier. Older locks without this field retain their prior response. All
angles use radians. World locks ignore ancestor rotations; Figure locks use the
existing figure rotation channel. Parent references are captured from the nearest
movable ancestor at setup and remain stable native IDs.

Parent locks can add a second rotation through **Add a second rotation**. Choose
its joint ID (0 disables it), multiplier and captured rest angle. The optional
`secondary: {reference, restAngle, multiplier}` contributes that joint's angle
change in the same authored/rendered space as the primary reference. Whole-figure
rotation is applied once. This lets native constructions combine independent
turn and nod controls without singular angle-bisector constructions. Both
references participate in dependency validation, remapping, saving and undo.

The iterative dependency plan includes hierarchy, connector anchors and explicit
stretch drivers. Compilation is O(V + E), cached by definition, and yields during
cold validation/preparation. Cycles and missing references fail before publication.
Evaluation uses one state array per figure instance and carries no solver state
between frames. Collapsed/reversed spans, arbitrary seeks and undo are deterministic.
Widths and stretch influence are bounded. A fully compressed detail cannot be
directly inverse-posed until its driver expands.

The engine session (`styk-edit/src/pose.rs` and the rig modules beside it) owns the commands and sparse relationship history. Changes
invalidate affected figure instances. Duplicate/combine remap internal references
and retain external anchors as appropriate. Derived joints reject conflicting IK;
ordinary skeleton anchors can still be driven by IK. Shared geometry supplies
Canvas, WebGPU, prepared playback, polygons, joins and rendered exports.

Native `.styk`/`.stkz` saving preserves editable relationships. Pivot `.piv`/`.stk`
export rejects them with an actionable message rather than silently losing them.
Use native formats or rendered exports. Existing Stick Nodes imports remain
pose-only adaptations with their existing warnings; this implementation does not
claim to translate every imported Stick Nodes constraint. Setting a new figure
origin and splitting configured segments are guarded where their existing native
operations cannot preserve these relationships. Set the origin and split parts
before configuring them. Deleting an externally referenced anchor is rejected;
reconnect or remove its relationships first.

## Verification and measurements

The Builder surface update passed 126 focused rig/construction tests and the
full suite passed 1,997 of 1,998 tests. The existing scrub playhead-input test
still reports `''` instead of `'12'`; it is unrelated to this change. Syntax
checks passed for 914 JavaScript files. Browser checks passed for canvas face
creation, origin connectors, overlapping attachment selection, surface controls,
all sixteen example insertions, isolated tests, normal/Ctrl posing and compact
Builder menus. All nineteen sampled WebGPU/prepared renders matched exactly;
SVG stayed within the existing edge-antialiasing tolerance.

On Node 24.11.0 on this workstation, 100 solid instances evaluated in a median
13.38 ms with face visibility, versus 13.70 ms without it, reducing submitted
faces from 1,000 to 480. These are CPU geometry timings, not end-to-end frame
rates. The 20,000-connector case still takes about 53.6 ms synchronously and
needs prepared playback for responsive viewing. See the current benchmark JSON
and `artifacts/rig-solids/`, `artifacts/rig-insertion/` and `artifacts/rig-constraints/`
for this update's evidence. The reports below describe earlier revisions.

The imported-properties follow-up passed 101 focused rig tests, including native
file insertion for all sixteen examples and identical geometry at three poses
after removing each preset's identity and control metadata. The mechanism browser
suite checks preview-only sliders, ordinary imported properties and Test rig UI,
posed insertion, reversible native edits and compact/dark preview layouts.
The solid, rig-setup and insertion browser suites also passed, including normal
properties for opaque solids and preservation of builder work. The regenerated
ten mechanism asset/demo files passed decoding, inbetween and loop checks.

The earlier mechanism-asset follow-up passed 84 focused rig tests and the then-current
`tests/rig-mechanisms.browser.mjs` workflows: all five previews, live Animate
sliders, preview isolation, tested-pose insertion, exact gesture/insertion undo,
and compact/dark layouts. Existing rig setup and insertion browser suites also
passed. Nineteen sampled editable/prepared renders matched exactly; SVG stayed
within the existing antialiasing tolerance. Ten generated native asset/demo files
were decoded and checked at intermediate poses, with connected endpoints and
closed demo loops. Evidence is in `artifacts/rig-mechanisms/` and
`artifacts/rig-constraints/`. The full recorded run passed 1,988 of 1,989 tests;
the sole failure remains the existing scrub playhead-input assertion. Syntax,
changelog and whitespace checks passed.

The following reports describe the earlier connector and solid work.

`tests/rig-constraints.test.mjs` covers real sliding handles, curved/nested spans,
projection against an independent formula, collapse/reversal, record-order
independence, native container round trips, cooperative cancellation, joins,
combining, duplication, IK, sparse history and Ctrl-only stretch. The six advanced
rigs undergo repeated nonsequential poses, depth collapse and extreme slider poses.

`tests/rig-constraints.browser.mjs` exercises builder setup, actual normal/Ctrl
mouse drags, gesture undo, absence of blue rig pixels in Animate, temporary test
isolation, the gallery, file-input native imports, and compact/light/dark layouts.

`tests/rig-insertion.browser.mjs` adds all six examples through the Library UI,
checks selection and Animate mode, transfers a tested rotation and sliding pose,
and checks exact-document undo, retention of existing/new builder work and
locked-layer rejection. Its browser run passed with no page errors; screenshots
and a report are in `artifacts/rig-insertion/`. The insertion follow-up also
passed all 46 rig/builder-session unit tests and syntax checks for 898 JavaScript
files.

The preceding full feature unit run passed 1,917 of 1,918 tests. Its remaining failure is the
existing `tests/scrub-backpressure.test.mjs` playhead-input assertion (`''` versus
`'12'`), also reproduced independently. All 36 rig unit tests passed. The repository
syntax check passed for 896 JavaScript files, and the changelog check passed.

On this Windows workstation with Node 24.11.0, the final standalone geometry
benchmark measured median times of 2.04 ms for 1,000 connector segments, 7.95 ms
for 5,000 and 44.57 ms for 20,000. The six example rigs measured 0.11–0.84 ms
median (0.22–1.68 ms p95). These are geometry timings, not end-to-end frame rates.
20,000 constrained segments exceed a 60 FPS synchronous editing budget; prepared
playback retains the existing worker and bounded-cache path. GC heap differences
are reported as diagnostics, not a proof of leak absence. (The script that measured them went with the JavaScript geometry evaluation it timed.)

## Reference behavior

See [the guide/video/APK study](research/STICK-NODES-RIGGING-RESEARCH.md) for the inspected
Stick Nodes formulas, behavioral differences, setup recipes and the latest
Smart Stretch/angle-lock verification, including 69 focused tests and 14 rendered
comparisons. Measurements above record the earlier connector work.

Stick Nodes' [connector update](https://sticknodes.com/new-version-4-2-0-the-connector-joint-update/)
establishes two-anchor connectors and their middle attachment joint. Its
[Smart Stretch update](https://sticknodes.com/new-version-2-4-8-the-one-stretchy-boi-update/comment-page-5/)
describes deformation of attached parts. StykAnimate uses its own native dependency
model and one-action setup, with explicit rigid exceptions and Ctrl-to-stretch
posing as requested.
