# Engine: evaluation

How the engine turns a document and a tick into world-space geometry and a
draw list (`engine/crates/styk-eval`). The JavaScript editor's evaluation
(`src/pivot/geometry.mjs`, `src/layer-sheet.mjs`, `src/animation-pose.mjs`, …)
is the oracle while both exist.

## Contract

- `Prepared::new(document)` builds the timing tables once per document
  revision (native timeline rows, layer-sheet pose tracks, movieclip
  replacement tracks, presence clocks). `Prepared::evaluate(tick)` is a pure
  function of the prepared document and the tick: any thread evaluates any tick.
- A `Frame` is the evaluated scene: objects (`Arc<Object>`, shared with the
  document when untweened), draw order, camera, backgrounds, presence-clock
  movieclips, where each pose came from (`origins`, for editing) and the frame's
  effects (`vfx`, see [vfx.md](vfx.md)).
- `geometry::build(document, frame)` resolves joins, rigs ([rigs-ik.md](rigs-ik.md)),
  IK, movieclip instances, Stick Nodes shapes and 3D ([spatial.md](spatial.md):
  perspective, one-sided surfaces, figure and attached movieclip meshes) into a
  `Scene`: per object its joints and drawable items in world units, and the
  scene's evaluated meshes and surface depths.
- `drawlist::encode_composed(document, assets, scene, overrides, ghosts, order)`
  turns a scene into a draw list ([rendering.md](rendering.md)): translucent
  figures and outlines become isolation groups; onion ghosts are tinted,
  faded groups placed in `composeSceneGroups` order (`onion.rs`); session
  state (hidden figures, drag offsets, the canvas colour) comes in `Overrides`.

## Order of evaluation

1. Native keyframes tween with Pivot's rules (`evaluatedNativeFrame`): easing,
   Auto curves, colour and background transitions, IK controllers. Property
   channels then apply ([below](#property-channels)).
2. A layer sheet samples each layer's own pose track (`sampleLayerSheet`),
   applies its keys' movieclip replacements (`replaceMovieclipFrame`) and
   composes layers in order. Imported keys sample the native timeline with the
   sheet's `legacyAnimation` channels; when every layer, the scene and the camera
   share one native sample (or a layer has nothing), that sample is the frame,
   slots and all, as the editor returns its one object.
3. Movieclip instances choose their local time (`sampleMovieclipObjects`),
   layers order the draw order (`applyLayerOrder`).
4. The scene camera ([below](#the-scene-camera)): where it travels moves parallax
   layers, then camera-motion impulses shake the shot.
5. Effects resolve per object and for the scene.

## Property channels

Sparse keyed curves over the native timeline (`_styk.animation`, src/animation-channels.mjs,
src/animation-pose.mjs; `styk_eval::channels`). A document opened in the app has a layer
sheet, and its channels are the sheet's `legacyAnimation`, which the imported keys sample
(`legacySheetReport`); a native document (and a movieclip's own document) uses
`_styk.animation`. The loader reads them leniently into typed channels (`channels::parse`:
target, property, keys with their curves and flags; a channel the editor would refuse is left
out and noted), cached by record like effect clips. `Prepared` builds each pose channel's key
track once (`channels::Compiled`), and every native evaluation (`Prepared::native_at`, a
movieclip's fractional frames) applies them at the tick:

- **Pose channels** (`channels::pose`, `composePoseChannels`): a figure or layer channel
  replaces the figures it owns (a figure channel its figure, a layer channel the layer's other
  figures) with their pose in the frame its key track samples (`buildVirtualPoseTrack`: a
  native timeline of the keys' source poses at the document's version, hidden keys lasting
  nothing, a key without `interpolation` keeping its source's easing; `maskedRanges` show
  nothing, `useBasePose` the native pose, `nativeProperties` keep the native scale,
  transparency, colour, depth and outline). Joins are resolved again by identity: a figure
  whose parent left, or whose joint is gone, stays where its own frame drew it; a joined figure
  turns by the change of its parent's joint direction (`handleOrientation`, through the
  original tree for a figure with an animation origin). Unreplaced figures keep their slots,
  arrivals follow; each layer keeps its sampled pose's stacking order, an `orderAnchor` figure
  right after its anchor. The camera's and the scene's tracks set the camera and the
  background, colour key and scene effects (blank before their first key).
- **Scalar channels** (`channels::scalar`, `composeAnimationChannels`): sampled with
  `sampleAnimationChannel` (easing modes, Auto with neighbouring Auto keys, held and discrete
  properties, `passthrough` intervals that hand the property back, Pivot's monotone cubic for
  `nativeCurve` keys, `nativeRotation` along the shortest turn, `nativeValueMode` colour and
  opacity through Pivot's bytes, colours per byte rounded, effect colours through
  `interpolateVfxColor`), effect stacks first, then fill styles, then the rest in saved order:
  effect parameters onto the tweened stacks (`applyVfxParameter`: clamped numbers, colours as
  keyed, `enabled`, whole stacks, the scope), the camera, the background and colour key, a
  figure's colour override and depth, style overlays (`setAnimationStyle`, resolved again with
  the instance's sprite; a definition-scoped channel wins over the unscoped one, a missing node
  stays dormant), and last the figures' scale, transparency and rotation from the roots down
  (a rotation carries into the figures joined below, ghost bones included), origins corrected,
  then positions, where a joined figure's position moves its root figure (measured on the
  frame's geometry).
- The native timeline lasts until the channels' last frame (`animationEndTick`); channel keys
  are boundaries of the presence clocks; effect channels make evaluation resolve effects even
  where no pose saves a stack; a follow camera's samples keep only the channels of the camera,
  of layers and of the followed figures (`followSamplingReport`).
- The evaluated frame as records composes them too, record for record
  ([below](#the-evaluated-frame-as-records)), so `styk-edit` edits documents whose channels
  are a layer sheet's `legacyAnimation` (every document opened in the app); channels on a
  native timeline are still edited by the editor alone.

## Animation origins

Set Origin re-roots a figure's construction tree at another joint while its animation
keeps the original pivot and joint basis (`styk_eval::origin`, `animation-origin.mjs`,
`animation-origin-support.mjs`). The figure's `_styk.animationOrigin` is compiled at load
against its segments: the original tree re-derived from them (`animationOriginLayout`), or,
once construction edits removed joints of it, the retained support graph whose removed
bones are ghosts. A pose stores its pivot (`_stykAnimationOrigin`: `x`, `y`, a local
`offsetX`/`offsetY` after an edit moved the pivot's vertex, and the ghosts' poses).

- A native tween interpolates the pivot (and its offset when either key has one) and the
  angles of the original tree relative to their parents there, as before Set Origin; with a
  support graph the bones are interpolated as their own tree, ghosts included.
- Every native interval (exact keys included) then places each unjoined figure's root so
  its pivot lands where the pose says (`correctAnimationOrigins`), with V8's trigonometry
  (`styk-math`). Poses a layer sheet shows directly, and edit frames, come as the editor
  left them.
- The figure's rotation (`animationRotation`: the rotation reference's turn) is what rigs,
  inverse kinematics, meshes and attached movieclips read (`origin::rotation`, also behind
  `ik::figure_angle`).
- `Records` uses the same typed origin arithmetic at exact keys and fractional intervals,
  including scalar property previews. Its raw writer preserves unknown pivot/ghost fields,
  record key order and unchanged COW identities; a corrected root drops runtime geometry.
  Inspector rotation and joined world positions share the typed origin/geometry owners.
  `records-fixtures.mjs` records origin fixtures every half tick: layout, real local offsets,
  retained ghost support, joins, zero scale and property previews. `tests/records_origin.rs`
  compares full bytes and scalar values and proves the fixtures need their pivots.

The typed compiler rejects malformed retained support before raw editing can index it.
Known indices must be finite integers in range; bindings and vertex nodes are unique and
complete, poses are finite within native length range, references match the rotation bone,
and ancestry is acyclic. Sixty-eight malformed cases are recorded from the existing editor
validator, with unchanged raw metadata and atomic command refusal checks. Cooperative
import and per-object validation remain in their existing JavaScript owners.

## Prepared picking and scene-cache lifetime

`styk_eval::picking` provides native handle generation/picking, segment-body picking,
origin and measured-bounds marquee predicates, and the gesture-local construction
index, and `closest_joint` with a borrowed `JointOrder`. Queries borrow ready typed `Scene`/`Frame` geometry and preserve the editor's
ordering, inclusive radii, exclusions, snap priority and latch. Raw segment drawing
endpoints/point ranges/thickness survive before expanded sprite geometry; stored
arc arithmetic uses `styk-math`. These are native prerequisites: the app still owns
query preparation, bounds/resource identity, overlays and interaction sequencing.
An explicit measured rectangle is required for the bounds predicate; extent is not
substituted for live drawing alpha or effect bounds.

The existing movieclip scene cache retains at most 64 scenes/64 MiB per clip. All
clips, nested documents and still-live revisions from one `Loader` share its
`SceneBudget` (64 MiB/1,024 entries by default). Admission uses checked atomic
reservations; a reservation follows the cache entry through eviction, cancellation
and disposal. Oversized or saturated scenes remain usable without cache retention.
`Scene::retained_bytes` is computed once, including resolved effect/paint buffers,
and read in O(1). Shared immutable payloads can be conservatively charged twice.
This does not bound authored payloads, transient/caller-held scenes, allocator
overhead, unrelated caches or independent loader lineages.

Platform-neutral additions for crate consumers: `Document::scene_budget`,
`Loader::with_scene_limits`/`scene_budget`, `geometry::SceneBudget`,
`Scene::figure_of`/`retained_bytes`, `ObjectGeometry::lengths`/`raw_segments`,
`RawSegment`, `Segment::control_detail`, and the public picking types/functions.
`JointOrder::new` validates the provided slot permutation once; queries retain the
editor's later-entry ties, inclusive CSS radius and all-joint traversal without
allocating an order on each pointer move. Forty-four fixture files record 201,792
actual editor queries across 20 projects / 54 frames, including live edited and
reopened painter-map order. Additive `ClosestJointOptions`, `JointHit` and
`QueryError::InvalidOrder` are platform neutral. Browser query wiring and
actual-shown snapshot readiness remain pending.

## Colour transitions

A pose's `color_transition` (`{from, to, t}`; no command writes one, older documents
carry it) replaces the object's override wherever the editor colours its figure
(`objectColor`): every segment, polygon and mesh palette colour, and the paint stops and
second colour of a gradient, is mixed with both overrides and taken `t` of the way between
them, rounded (`geometry::object_rgb`). Items keep an index into the scene's transitions
(`Scene::transitions`, so items stay plain data) for the draw list's gradients; movieclip
contents use their own object's. A tween keeps the first key's
transition, as the editor's does. Whether a two-colour gradient is drawn at all still
follows the override alone (an opaque override draws the segment solid), as in the editor.

## Stick Nodes sprites

An imported Stick Nodes sprite keeps its stretch and pivot on the pose (`_sticknodesSprite`:
`ratio`, `pivotX`, `pivotY`; the Stick Nodes importer writes it). The editor applies them to
the picture's asset when it builds the segment (`sticknodesSpriteAsset`): shown at the
asset's width and its height times the ratio, anchored at the pivot. The engine applies them
where it resolves an object's figure, after a style overlay (`Loader::styled_object`,
`sticknodes::sprite_figure`, shared by identical sprites), so the draw list, effect bounds
and editing all read the stretched asset. `styk compare` checks where pictures are drawn
when the reference has them (`reference.mjs --images`).

## The scene camera

What the camera does when the scene is seen through it: prepared playback frames
always, edit frames only in the camera preview (`cameraEnabled`). The editor applies
both at render time (`cameraAtTime`, `parallaxResolver`); the engine works them out
with the frame and draws them.

- **Travel** (`cameraTravelAt`, `Prepared::travel`) is where the camera is: the
  authored camera, tweened with its baked camera-motion offset (`_parallaxMotionOffset`,
  tweened when either key has one, like the other camera channels), moved by the follow
  clips active at the frame's time.
- **Follow clips** (`styk_eval::follow`, `camera-follow.mjs`): per tick the followed
  figures are evaluated in a projection of the document holding only them, the figures
  they hang from and the camera (`followSamplingReport`), and measured from their
  geometry (`ObjectGeometry::extent`, `figureBounds`: visible segments with half their
  stroke, circles by radius, curves by their points, every polygon including culled
  surfaces, a movieclip's handle). A forward pass shapes the samples per clip frame
  (dead zone with hysteresis, look-ahead, holding the last seen target or aiming at the
  first one ahead, a critically damped spring per axis, framing zoom) into offsets and a
  log zoom stored in single precision, as the editor's `Float32Array`; overlapping clips
  blend by weight. The pass is sequential: a clip's path is shaped once per prepared
  document, lazily up to the frame asked for and 256 frames beyond, by whichever thread
  needs it first, outside any lock (the longest path published wins: a pointer swap under
  a spinning lock, D7). The editor keeps its paths across edits and resamples from the
  key before a change; the engine shapes each revision's paths afresh.
- **Parallax** (`styk_eval::parallax`, `layer-parallax.mjs`): each layer whose parallax
  is on moves by `(1 - response) × (travel - reference - baked offset)` per axis; a
  joined figure moves with the layer of its join chain's root. `Frame::parallax` holds
  the offset of every object by slot (`None` when nothing moves, and always for a
  movieclip's own frame: its contents move with their instance). It is a translation
  of the whole object, artwork, effects and movieclip contents alike, which the draw
  list takes as one more per-object translation after a drag's
  (`Parallax::translations`); geometry, records and editing never see it. Onion skins
  take none: the editor shows them only with the camera off.
- **Impulses** (`camera::at_time`, `sampleCameraMotion`) shake the shot from the
  travelled camera.
- **Edit frames** carry their time on the camera-motion clips (`_cameraMotionTick`); in
  the camera preview the stage draws them through `cameraAtTime` worked out against the
  published generation (a follow path reflects an edit once the session publishes it).

## Retained movieclip sources

The typed loader reads `movieclipSource` into `MovieclipSource` with the immutable source
document and its local-to-source tick map. Evaluation and recorded command materialization
sample that same source, including native/sheet channels, presence clocks, membership and
retained VFX timing. `Frame` and `Keyframe::retained_vfx_tick` carry the inherited effect
clock through the common frame finishing owner. Unknown source fields remain in the store.
Editor-built source, coverage, generator and timing fixtures certify the recorded paths;
unrecorded command combinations remain gated independently of rendering.

## Not evaluated yet

Frame drafts (temporary editing state shown only as onion skins) are not read:
the interface hands the engine the poses it shows ([rendering.md](rendering.md#every-document)).
Actual shown/resource readiness and no-thread fallback still need their canonical app
boundary before JavaScript evaluation is deleted. The work queue in the plan orders them.

## Testing

- `styk compare <file> <reference.json>` against `engine/tools/reference.mjs`
  (every primitive and joint of the sampled ticks; `--vfx` adds effects, `--camera`
  the shot camera and each object's parallax offset, `--scene` the background and
  colour key, `--style` each object's outline and each segment's second colour;
  `--native` evaluates the document on its native timeline instead of as the app
  loads it).
- Fixture suites built by the editor's own commands:
  `engine/tools/ik-fixtures.mjs`, `eval-fixtures.mjs`, `vfx-fixtures.mjs`,
  `spatial-fixtures.mjs`, `origin-fixtures.mjs`, `channel-fixtures.mjs` (byte-stable),
  checked by `cargo test -p styk-eval`. Each channel fixture is checked as saved (against
  the editor's native timeline) and as the app holds it (a layer sheet with
  `legacyAnimation`, against the app's evaluation); `tests/channels.rs` also requires that
  each fixture, each channel kind and each curve flag it uses changes the result when
  removed.
- `npm run engine:parity -- --corpus` runs the benchmark files at every tick.

## The evaluated frame as records

A gesture commits by storing the frame the editor shows: `snapshotPoseFrame(
editor.evaluatedFrame)` becomes a pose source. `styk_eval::records` produces that record,
byte for byte, so the commit can run in the engine ([editing.md](editing.md)). It mirrors
the record-level shape of the editor's evaluation (which record a pose comes from, which
keys a tween writes and in which order: `sampleLayerSheet`, `evaluatedNativeFrame`,
`buildVirtualPoseTrack`, `sampleMovieclipObjects`, `applyLayerOrder`,
`snapshotPoseFrame`) and takes every interpolated number from the typed evaluator, so the
arithmetic has one implementation. Frames it does not produce yet answer `Unported` with
the reason.

- Covered: imported layers (the native timeline, exact and tweened), layers with authored
  pose keys (virtual pose tracks), the whole-pose shortcut and the per-layer composition,
  tweened IK controllers (`interpolateIK`), figure and scene effect stacks
  (`interpolateVfx`, parameters resolved in the registry's order, paints normalized),
  layers that mix imported and authored keys (the window of keys around the playhead),
  movieclip frame replacements (`replaceMovieclipFrame`, tweened along their own track),
  movieclips leaving the frame outside their span, layer order, 3D poses between keys
  (`interpolateSpatialPose`'s record), hidden pose keys, and property channels (below).
- Not yet (each answers `Unported`): figures joined to a hidden movieclip and a movieclip's
  own retained-source document. A tweened camera keeps its baked camera-motion
  offset (`_parallaxMotionOffset`) as the editor writes it.
- **Property channels as records** (`styk_eval::records` `channels.rs`): where the editor
  composes them, so do records: on the native timeline a layer sheet's imported keys sample
  (`sampleLegacy`, with the sheet's `legacyAnimation`; a native document's own
  `_styk.animation`), which also lasts until the channels' end, and on the frame a property
  edit writes (`Records::compose_channels`: `at(report, tick)` with the one-key channels
  `_sheetPropertyEntries` builds). `composePoseChannels` and `composeAnimationChannels` are
  mirrored on the records (owners, replacements, joins re-resolved by identity, native
  appearance, stacking anchors; effect stacks first, then fill styles, style overlays with
  scopes winning, the camera copied with its defaults, transforms from the roots down), and
  `animationPropertyValue` reads a property from a frame record
  (`Records::property_value`). Values come from the drawing path's sampling
  (`Channel::sample_at`): a key's own value as saved (a paint or stack exactly as written),
  an interpolated one as the typed curve works it out; geometry (a joined figure's position,
  a figure that comes loose) from the typed view of the record. The Bézier easings' `t ** 3`
  is `styk_math::pow`, V8's own (D16; a channel value differed in its last bit with `t * t * t`).
- Pivot's own easing unwraps each angle along the whole run of tweened keys before the
  interval. The drawing path unwraps from the previous key only (constant time, the same
  picture); records follow the editor's chain (`evaluate_native_exact`), or a stored
  angle would sit whole turns away (found on `hitoshi vs suzu tomiee ssj.piv`, tick 182;
  the `eval-legacy-winding` fixture fails without it).
- Angles are tweened through `styk_math::shortest`: with the platform's `sin` and `atan2`
  an IK target rotation came out as `-0.06` where the editor stores
  `-0.05999999999999999` (D16).
- Harness: `engine/tools/records-reference.mjs <file> <folder>` records the editor's loaded
  report and, per tick, the snapshot (SHA-256, and the JSON for small documents);
  `styk records <folder> [--write]` compares. `--native` keeps a document's channels on its
  native timeline (no layer sheet); `--entries <list.json>` records, per tick, the frame a
  property edit writes there and the channels it built. `engine/tools/records-fixtures.mjs`
  records every editor-built fixture into `tests/fixtures/records/`, the channel fixtures
  in both forms and seven sets of property edits (`entries-*`); `tests/records.rs` requires
  every recorded frame to be produced and identical, and every channel fixture and property
  edit to differ somewhere without its channels.
