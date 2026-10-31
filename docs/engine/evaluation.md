# Engine: evaluation

How the engine turns a document and a tick into world-space geometry and a
draw list (`engine/crates/styk-eval`). The recorded fixtures were made from the JavaScript editor's evaluation
([README](README.md#fixtures)); the recordings are frozen and are the oracle now. The interface evaluates nothing:
the JavaScript keeps only what a document stores (the validation of its records, `src/pivot/read-view.mjs`) and the views it reads from the engine.

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

1. Native keyframes tween with Pivot's rules: easing,
   Auto curves, colour and background transitions, IK controllers. Property
   channels then apply ([below](#property-channels)).
2. A layer sheet samples each layer's own pose track,
   applies its keys' movieclip replacements and
   composes layers in order. Imported keys sample the native timeline with the
   sheet's `legacyAnimation` channels; when every layer, the scene and the camera
   share one native sample (or a layer has nothing), that sample is the frame,
   slots and all, as the editor returns its one object.
3. Movieclip instances choose their local time, layers order the draw order (`applyLayerOrder`).
4. The scene camera ([below](#the-scene-camera)): where it travels moves parallax
   layers, then camera-motion impulses shake the shot.
5. Effects resolve per object and for the scene.

## Property channels

Sparse keyed curves over the native timeline (`_styk.animation`, validated by src/animation-channels.mjs; `styk_eval::channels`). A document opened in the app has a layer
sheet, and its channels are the sheet's `legacyAnimation`, which the imported keys sample; a native document (and a movieclip's own document) uses
`_styk.animation`. The loader reads them leniently into typed channels (`channels::parse`:
target, property, keys with their curves and flags; a channel the editor would refuse is left
out and noted), cached by record like effect clips. `Prepared` builds each pose channel's key
track once (`channels::Compiled`), and every native evaluation (`Prepared::native_at`, a
movieclip's fractional frames) applies them at the tick:

- **Pose channels** (`channels::pose`): a figure or layer channel
  replaces the figures it owns (a figure channel its figure, a layer channel the layer's other
  figures) with their pose in the frame its key track samples (a
  native timeline of the keys' source poses at the document's version, hidden keys lasting
  nothing, a key without `interpolation` keeping its source's easing; `maskedRanges` show
  nothing, `useBasePose` the native pose, `nativeProperties` keep the native scale,
  transparency, colour, depth and outline). Joins are resolved again by identity: a figure
  whose parent left, or whose joint is gone, stays where its own frame drew it; a joined figure
  turns by the change of its parent's joint direction (through the
  original tree for a figure with an animation origin). Unreplaced figures keep their slots,
  arrivals follow; each layer keeps its sampled pose's stacking order, an `orderAnchor` figure
  right after its anchor. The camera's and the scene's tracks set the camera and the
  background, colour key and scene effects (blank before their first key).
- **Scalar channels** (`channels::scalar`): sampled with
  `Channel::sample_at` (easing modes, Auto with neighbouring Auto keys, held and discrete
  properties, `passthrough` intervals that hand the property back, Pivot's monotone cubic for
  `nativeCurve` keys, `nativeRotation` along the shortest turn, `nativeValueMode` colour and
  opacity through Pivot's bytes, colours per byte rounded, effect colours through
  `vfx::paint::interpolate`), effect stacks first, then fill styles, then the rest in saved order:
  effect parameters onto the tweened stacks (clamped numbers, colours as
  keyed, `enabled`, whole stacks, the scope), the camera, the background and colour key, a
  figure's colour override and depth, style overlays (resolved again with
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
  its pivot lands where the pose says, with V8's trigonometry
  (`styk-math`). Poses a layer sheet shows directly, and edit frames, come as the editor
  left them.
- The figure's rotation (`animationRotation`: the rotation reference's turn) is what rigs,
  inverse kinematics, meshes and attached movieclips read (`origin::rotation`, also behind
  `ik::figure_angle`).
- `Records` uses the same typed origin arithmetic at exact keys and fractional intervals,
  including scalar property previews. Its raw writer preserves unknown pivot/ghost fields,
  record key order and unchanged COW identities; a corrected root drops runtime geometry.
  Inspector rotation and joined world positions share the typed origin/geometry owners.
  The recorded origin fixtures hold every half tick: layout, real local offsets,
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
when the reference has them.

## The scene camera

What the camera does when the scene is seen through it: prepared playback frames
always, edit frames only in the camera preview (`cameraEnabled`). The engine works
both out with the frame and draws them; the interface asks for the shot (`shot`,
below) and puts it on the frame it maps points through.

- **Travel** (`Prepared::travel`) is where the camera is: the
  authored camera, tweened with its baked camera-motion offset (`_parallaxMotionOffset`,
  tweened when either key has one, like the other camera channels), moved by the follow
  clips active at the frame's time.
- **Follow clips** (`styk_eval::follow`): per tick the followed
  figures are evaluated in a projection of the document holding only them, the figures
  they hang from and the camera, and measured from their
  geometry (`ObjectGeometry::extent`, `figureBounds`: visible segments with half their
  stroke, circles by radius, curves by their points, every polygon including culled
  surfaces, a movieclip's handle). A forward pass shapes the samples per clip frame
  (dead zone with hysteresis, look-ahead, holding the last seen target or aiming at the
  first one ahead, a critically damped spring per axis, framing zoom) into offsets and a
  log zoom stored in single precision; overlapping clips
  blend by weight. The pass is sequential: a clip's path is shaped once per prepared
  document, lazily up to the frame asked for and 256 frames beyond, by whichever thread
  needs it first, outside any lock (the longest path published wins: a pointer swap under
  a spinning lock, D7). The engine shapes each revision's paths afresh.
- **Parallax** (`styk_eval::parallax`): each layer whose parallax
  is on moves by `(1 - response) × (travel - reference - baked offset)` per axis; a
  joined figure moves with the layer of its join chain's root. `Frame::parallax` holds
  the offset of every object by slot (`None` when nothing moves, and always for a
  movieclip's own frame: its contents move with their instance). It is a translation
  of the whole object, artwork, effects and movieclip contents alike, which the draw
  list takes as one more per-object translation after a drag's
  (`Parallax::translations`); geometry, records and editing never see it. Onion skins
  take none: the editor shows them only with the camera off.
- **Impulses** (`camera::at_time`) shake the shot from the travelled camera.
- **Edit frames** carry their time on the camera-motion clips (`_cameraMotionTick`); in
  the camera preview the stage draws them through the shot worked out against the
  published generation (a follow path reflects an edit once the session publishes it).
  The interface does not evaluate camera motion: it reads the shot with `shot` and maps
  points through the camera of the frame it holds (`effectiveCamera`).

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

- `styk compare <file> <reference.json>` compares the engine with a recorded dump of the editor's
  evaluation (every primitive and joint of the sampled ticks; the dump may add effects, the shot
  camera and each object's parallax offset, the background and colour key, each object's outline
  and each segment's second colour, and an evaluation on the native timeline). The dumps are the
  frozen fixtures' `*.reference.json` files; nothing records new ones from the JavaScript.
- The fixture suites (`ik`, `eval`, `vfx`, `generators`, `spatial`, `origin`, `channels`, `records` under
  `engine/crates/styk-eval/tests/fixtures/`) were built by the editor's own commands and are frozen; `cargo test -p
  styk-eval` checks them. Each channel fixture is checked as saved (against the editor's native timeline) and as
  the app holds it (a layer sheet with `legacyAnimation`, against the app's evaluation); `tests/channels.rs` also
  requires that each fixture, each channel kind and each curve flag it uses changes the result when removed.
  New or changed behaviour gets a Rust test that states its expected result ([README](README.md#fixtures)).

## The evaluated frame as records

A gesture commits by storing the frame the editor shows as a pose source. `styk_eval::records` produces that record,
byte for byte, so the commit runs in the engine ([editing.md](editing.md)). It follows
the record-level shape the recordings fixed (which record a pose comes from, which
keys a tween writes and in which order: the layer sheet, the native tween,
virtual pose tracks, layer order, the stored pose) and takes every interpolated number from the typed evaluator, so the
arithmetic has one implementation. A read of the frame on show never refuses for a document that opened: opening validates the
channels, joins and sources records read (a hand-built document with an unreadable channel answers `Unported`), what the
typed evaluator does not read of a pose (an effect stack, a 3D pose or an animation origin it ignored) is left as the record
holds it, as the typed evaluator draws it, and layer poses that join each other in a ring leave one figure loose.

- Covered: imported layers (the native timeline, exact and tweened), layers with authored
  pose keys (virtual pose tracks), the whole-pose shortcut and the per-layer composition,
  tweened IK controllers (`ik::tween`), figure and scene effect stacks
  (`vfx::interpolate`, parameters resolved in the registry's order, paints normalized),
  layers that mix imported and authored keys (the window of keys around the playhead),
  movieclip frame replacements (tweened along their own track),
  movieclips leaving the frame outside their span, layer order, 3D poses between keys
  (the record of a spatial pose tween), hidden pose keys, and property channels (below).
- A figure joined to a movieclip instance that is not shown (its placement ended, or a once-clip finished) comes loose
  where the whole frame had it (its root is the geometry of the frame with the instance in it, its join `null`), in the
  record and in the typed frame alike (`Prepared::apply_movieclips`). A tweened camera keeps its baked camera-motion offset
  (`_parallaxMotionOffset`) as the editor writes it.
- **Property channels as records** (`styk_eval::records` `channels.rs`): where the editor
  composes them, so do records: on the native timeline a layer sheet's imported keys sample
  (`sampleLegacy`, with the sheet's `legacyAnimation`; a native document's own
  `_styk.animation`), which also lasts until the channels' end, and on the frame a property
  edit writes (`Records::compose_channels`: `at(report, tick)` with the one-key channels
  the editor's property-entry builder makes). Pose and scalar channels compose on the
  records the same way (owners, replacements, joins re-resolved by identity, native
  appearance, stacking anchors; effect stacks first, then fill styles, style overlays with
  scopes winning, the camera copied with its defaults, transforms from the roots down), and
  `Records::property_value` reads a property from a frame record. Values come from the drawing path's sampling
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
- Harness: `styk records <folder> [--write]` compares the engine's records with a recording of the editor's loaded
  report and, per tick, the snapshot (SHA-256, and the JSON for small documents). The recordings kept in
  `tests/fixtures/records/` are frozen: every editor-built fixture, the channel fixtures in both forms (a
  document's channels on its native timeline, no layer sheet) and seven sets of property edits (`entries-*`: per
  tick, the frame a property edit writes there and the channels it built). `tests/records.rs` requires every
  recorded frame to be produced and identical, and every channel fixture and property edit to differ somewhere
  without its channels.

## The interface's frame

The interface reads the frame on show from the editor's session; no JavaScript evaluates it. The editor's
getters (`evaluatedFrame`, `geometry`, `timeline`, `totalTicks`) ask `src/engine/engine-shown.mjs`, which asks
the session (`EditSession.query`, `styk-edit/src/interface.rs`) at the playhead (`tick`, `frameIndex`; the
selection is the editor's to tell with a call, and the frame does not depend on it):

- `frame` is `Editor::shown_frame()` as JSON: the sheet property preview, the gesture's draft, the frame a commit
  keeps on show, else the document at the playhead (`Records::evaluated_editor_with`). `document` is the document's
  own frame under any of them, the base a gesture's draft is composed on. Each carries the time the document's effect clips are
  read at when it has any (`_vfxTimelineTick`, the playhead), which the effect gizmos compose the figures' effects at. The camera is read as the
  shot (`shot` below), not from a time on the frame.
- `motion` is the pose a motion-path edit shows at the playhead while it changes it
  (`Editor::motion_display_frame_worker`), `null` outside the ticks it changes.
- `timeline` is the rows (`[[start, count], …]`, `timeline::rows`).
- `geometry` is the scene built of the typed frame on show (`styk_eval::geometry::build_remembering`, the kind `build_shapes` builds; below): per object (slot) its root, one joint per
  segment, every segment as built (drawn or not: start, end, angle, bend, length, thickness, z, colour, opacity, curve
  points, a connector's handle, a 3D bone's `spatialFrame`; under a camera the joints and bone starts also carry
  `rawPoint`, where they are before perspective, which the commands that pose in perspective unproject from) and every polygon (culled ones flagged, a one-sided face that looks at the viewer `culled: false`, depth values of
  depth-tested faces), what inverse kinematics solved, and the figure's bounds as `boundsOf` measures them
  (`drawlist::app_bounds`). `write_groups` writes them as JSON (a segment is a row of numbers that leaves out what the reader works out: where it starts is where its parent ends, where it ends is its joint); `engine-shown.mjs` makes them the groups the canvas, the
  handles and the pickers read (`{objects: Map<slot, group|null>, orderedObjects, drawables, token, changedSlots,
  warnings}`; a group `{slot, obj, fig, root, joints, segments, polys, bounds, solvedAngles, solvedLengths}`, `drawables`
  built when read, with Stick Nodes shapes expanded). The groups carry no drawables for a 3D mesh or a movieclip's contents: the
  stage draws them in the engine, and a click on artwork asks the engine which figure the stage's frame paints at the point ([rendering.md](rendering.md#picking-artwork)).
- **One scene for every reader.** The typed frame of the record on show and the scene built from it are one `ShownScene`
  (`styk-edit/src/shown.rs`), kept for as long as the record, the playhead and the document's views are what it was made
  from. The interface's geometry, the commands that read where a joint is (`Editor::shape`) and the stage (`Stage::edit_session`)
  all read it: nothing converts the frame or builds the scene a second time. A frame of a document with effects is two (the
  effects the editor composed for the interface, the effects sampled at the tick for the stage); a frame of one without is one.
  Each build is made over the one before it (`BuildMemory`): an object whose typed node, figure, root and inverse-kinematics
  solution are the ones its last build had is not built again, so a gesture builds the figure it changes and the figures that hang
  from what moved, not the frame. The scene is the same scene whether objects were built or kept
  (`styk-eval/tests/build_memory.rs`).
- A geometry read names the read the interface holds (`since`). The session sends the groups of the objects built since that
  read, or all of them when the read named is not the one the session last answered. The groups held stay as they are, so the
  descriptors the canvas keeps by their identity stay valid while a gesture moves other figures. Unchanged: the same
  geometry object comes back.
- The values the interface shows of the frame (`animationValue`, `vfxEffects`, `segmentAnimationTarget`,
  `getIKSettings`, `getSpatialPose` and `getSpatialMotion` of the selected 3D bone, `sampleVfxClip`: an effect clip's
  effects with their keys sampled at a tick) are the session's reads too (`Editor::interface_query`, at the editor's
  whole view): a document the session does not answer them for (one that is not on a layer sheet, which the app never opens) raises the
  session's refusal (`unported: …`); the editor holds no body of these reads. The other queries the owner leaves to the editor
  (`animationChannel`, `getSpatialCamera`, `resolveTranslationSelection`, …) read stored
  records and the engine's frame and geometry; none evaluates a pose at the playhead.
- A read the session refuses (`figureDocument` of nothing to export, `sampleVfxClip` of a clip that is not there) reaches the
  interface as the localized error a refused call is: the session raises the message key, with the values the message
  names after a separator, and the owner turns it into the editor's error (`queryFailure`). A message that is not one of the
  editor's (an engine failure) is raised as it came.
- `previewGeometry` is the geometry of a frame the document does not hold: the first stroke on a drawing layer previews
  the frame on show with the new cel's figure and object added (`Editor::interface_preview_geometry`: the document with
  that figure and layer assignment, the given frame read against it, the full geometry of the result;
  `drawing-controller.mjs` reads it once for a gesture).
- The stage draws the same frame inside the engine (`Stage::edit_session`, [rendering.md](rendering.md)): the session's
  `ShownScene` of the frame, with its `tick` (and the camera-motion tick), whose effect clips are sampled at the tick as a
  prepared frame's are. It is drawn against the engine's document, which is the session's: the session and the engine convert
  the document once between them (`Engine::publish_tree_with` takes the views the session made of an edited document, and the
  session takes the engine's, `Session::adopt_views`), so a frame whose views are not the engine's yet is asked for again.

An editor the engine does not own has no frame, geometry or timeline: the reads raise `EngineUnavailable`. A movieclip being edited is a
document of the engine like any other: it has a session, and the frame, geometry, onion skins and trails are its.

What the interface still computes in JavaScript about motion is not the frame's evaluation: validation of the stored data that open,
save and paste run (`validateAnimationDocument`, `validateCameraMotion`, `validateVfxClips`, `validateIK`, the rig and pose-choice
validators), reads of stored records (the channel list, a key's fields, a definition's topology: `ikChain`, `rigConstraintPlan`
for the rig inspector), the style overlay of an instance over its definition (`resolveInstanceFigure`, applied to the engine's
object), and drawing maths (the easing curve of `keyframe-easing-view.mjs`, the gizmos' quaternions, a clip's fade envelope).
Everything that computes what the frame shows (a sampled channel, a pose, a camera, a solved IK chain or rig, an effect clip's
state) is the engine's.

## The interface's views

The frames around the one on show are sampled by the session too; no JavaScript evaluates a tick other than the
playhead's. `src/engine/engine-shown.mjs` asks `EditSession.query` (`Session::query`), at the playhead, for:

- **Motion-path trails** (`trails`, `styk-edit/src/trails.rs`): `{targets, range, maxPoints, budgetMs, held}` answers, per
  target (the camera, or a joint of a figure), the planned ticks (`plan_ticks`: the ends of the animation or of the window
  `range` ticks either side of the playhead, the playhead, an even share of the target's keys, an even stride through the
  rest, at most `maxPoints`) and the points sampled so far, `tick, x, y, flags, bodyX, bodyY` (flags: keyed, missing, has a
  body). A sample is the document evaluated at the tick (`Records::evaluated_with`), converted to a typed frame, and
  the geometry of the figures joined together with the target (`build_only`): one evaluation serves every target that needs
  the tick. A read samples until the budget has passed (the host's clock; at least one sample) and says whether the trail is
  `complete`. Trails are kept per target and replanned when the document, the window or the playhead moves; a changed document
  keeps the old points on show until they are sampled again. While a motion-path edit has moved, the trails are sampled from
  the document as the edit shows it (`Editor::motion_live`, stamped by the gesture and its pointer moves), the ticks it changes
  first, and from the document again when it ends. Each trail has a version, unique among all trails; a reader that holds
  the version is sent no points. `ghost` is the pose of the component at a trail point (`{rx, ry, lines, circles}`).
- **Onion skins** (`styk-edit/src/onion_skins.rs`): the stage asks the session directly (`Stage::set_onions(session, view,
  request)`), not the interface. The request is the settings, the counts the range reaches, the figures the interface
  hides and the selected ones. Candidates are the rows' poses or ticks either side of the playhead, or on a layer sheet each
  layer's neighbouring keys (a drawing layer's drawings, never the one on screen), far to near, at most `MAX_GHOSTS`.
  Each ghost is the document evaluated at its tick (the committed pose, never a gesture's draft) with the slots that are
  not drawn (scope, hidden figures and layers, the layer it samples), its opacity and tint. The set is kept while the
  document, the playhead and the request are the same; the stage keeps a pose per tick (`EditScene::update_ghost`) and
  builds its geometry when it is first drawn, over what the pose's last build made (`BuildMemory`, held only for the ghosts on show), so a
  document published anew (a commit, an undo) builds the objects of a ghost that changed, not all of them. A pose that replaces another of
  the same tick shares the objects whose records hold the same data (`Frame::keep_unchanged`, also how the shown frame keeps its own). The `onions` query answers the plan as JSON without the poses.
- **The camera** (`styk-edit/src/camera_views.rs`): `shot` is the camera the frame on show is seen through at the playhead
  (`Editor::camera_at_time`: follow travel, then the presets' impulse); `frameCamera` the authored camera of the document at a
  tick; `cameraSamples` what one clip alone does to the shot at each tick (`x, y, rotation, zoom`), the clip being given, so
  the inspector's graph plots an edit that is not stored yet (a follow clip's path is shaped against the document's figures
  and kept while the clip and the document are the same); `framing` the offset that keeps followed figures where they stand
  in the frame on show (`styk_eval::follow::framing_offset`).
- **Effect clips** (`styk-edit/src/vfx_clips.rs`, `styk-edit/src/interface.rs`): `vfxClips` answers, for clip records the interface
  holds (the document's, or a gesture's preview of one) and a tick, `{tail, active, plays}` per clip: the ticks its particles
  stay visible after its end (`generated::clip_tail`), whether the clip is on at the tick (`Clip::active_at`) and whether the
  inspector lists it there (on, or its generated effects still showing). The effects timeline draws the tail and lists the
  clips from it (`src/vfx-clip-views.mjs`). `vfxGroup` names, for a figure, the figures its connected effects filter together
  at the playhead (`FrameVfx`'s attached group, owner first, from `Prepared::frame_vfx`: the effects the stage draws, a crop's
  inherited effect clips included), or nothing when it owns no group; the effects gizmo measures them from the geometry it holds.
  A movieclip instance's geometry is its handle alone, so `vfxExtent` gives the gizmo what the instances among some figures
  paint, content included (`styk_eval::drawlist::objects_artwork_bounds`, `[x, y, width, height]`).

The same fixtures judge them: the evaluation fixtures (`tests/fixtures/eval/follow-*`, the camera records) for the
camera, and `styk-edit/src/views_tests.rs` and `tests/onion-skins.test.mjs`, `tests/motion-trails.test.mjs`,
`tests/camera-motion-graph.test.mjs` for what the views plan, sample and send.
