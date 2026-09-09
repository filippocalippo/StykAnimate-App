# Keyframe easing

Each key owns the transition **from itself to the next key on the same track**.
Auto computes a monotone cubic for each animated numeric property from its own
values and the actual spacing of neighboring keys. Consecutive Auto intervals
share duration-weighted harmonic tangents, maintaining continuous velocity at
interior keys. Flat spans and direction reversals have zero tangents; the start
and end of an Auto run ease from/to rest. Values stay between segment endpoints.
Two isolated keys therefore use smoothstep. Changing a neighboring value, time,
or mode recalculates the curve without storing stale generated handles.

The last key holds. Constant holds the outgoing value until the next key's exact
time; Linear interpolates at uniform speed. Ease in and Ease out use cubic timing
curves `(0.42, 0, 1, 1)` and `(0, 0, 0.58, 1)`. Bezier defaults to
`(0.42, 0, 0.58, 1)` and exposes draggable handles and numeric coordinates.
Coordinates stay in `[0,1]`, keeping progress bounded for scale, opacity and color.
The evaluator solves `x(u) = elapsedFraction` before evaluating `y(u)`.

`src/keyframe-easing.mjs` owns the mode registry, validation, canonical metadata,
and evaluation. Sparse keys store `interpolation` and, only for Bezier, a four-number
`bezier` array. `hold` remains an input alias for older projects; easing edits write
`constant`. Native document frames store the same fields under `_styk.easing`.

Pose-track wrappers carry their outgoing key's metadata into the native evaluator.
For manual timing modes the native evaluator applies the timing curve once,
before interpolating pose, camera and background properties. Auto instead passes
raw time into the shared `autoValue` numeric evaluator for each property. Scalar
tracks use the same evaluators, including independent ARGB components. Native
pose angles unwrap along the shortest arc; explicit scalar rotations retain full
turns. Missing identities, passthrough keys, zero-length intervals and non-Auto
modes break automatic tangent continuity. Each sample needs at most four keys,
with binary search for sparse tracks and shared identity maps for native poses.
Background identity channels are discrete and expose Constant only; Scene pose
tracks ease image crossfades locally because image identities have no numeric
tangent. Auto does not expose manual Bezier controls.

The global auto-easing control and its editor setters are removed. Imported Pivot
`auto_easing` data remains a native compatibility fallback for intervals without
explicit easing. An explicit key setting disables that fallback for its interval;
it never combines a timing curve with automatic native tangents. Lazily adopted
native tracks retain inherited intervals until the user gives them an explicit mode.

`setAnimationKeysEasing` edits independent keys in one undo command, adopting native
tracks as needed. `setFramesEasing` edits the shared native frame sequence. Neither
operation bakes source poses. Copying, retiming and duplication carry key metadata.
Native Pivot export materializes explicit easing at output ticks and strips the
authored metadata so it cannot be applied twice. Worker patches carry both frame
and channel changes and invalidate prepared playback.
Onion skins also track adjacent Auto dependencies. Destructive camera baking and
clipboard insertion preserve affected Auto runs at integer display ticks within
the existing sampling budgets. Native frame baking includes adjoining Auto
intervals before replacing any source, so partial baking cannot change unbaked
neighboring motion. These baked regions preserve display samples, not the
original continuous curve between display ticks.

`keyframe-easing-popover.mjs` anchors the nonmodal, light-dismiss editor above the
selected key in both timeline implementations. Presets commit on selection; Bezier
uses an explicit Apply action for its editable curve. Escape and outside clicks
dismiss uncommitted changes. `keyframe-easing-view.mjs` contains only controls and
curve rendering, using the shared evaluator for its preview.
The simple filmstrip also exposes Keyframe easing in its context menu. Stored
frame edits preserve an unfinished Add draft.
