# Camera and neighboring-pose commands

The commands below are commands of the engine session (`engine/crates/styk-edit/src/camera_commands.rs`);
`Editor` forwards each call to it (`src/engine/engine-owner.mjs`). Camera
coordinates are offsets from the animation center; angles are radians and scale
is the camera viewport size relative to the animation dimensions. A smaller
camera scale zooms into the animation.

| Command | Behavior |
| --- | --- |
| `copyCamera()` / `pasteCamera(indices)` | Copy the displayed pose and paste into the selected stored keys. The clipboard survives loading another document and does not share mutable values. |
| `setCameraValues(patch, indices)` | Set only supplied `x`, `y`, `scale`, `angle_rad` channels absolutely. |
| `transformCamera(delta, indices)` | Add X/Y/angle offsets; multiply each existing scale by the supplied positive factor. |
| `resetCamera(indices)` | Reset position, angle and scale. |
| `centerCamera(axis, indices, {boundsOf})` | Follow the bounds of matching selected UIDs in each selected key. `axis` is `both`, `x` or `y`; the remaining channel, scale and rotation stay intact. Optional artwork bounds use the inspector's existing resource-aware helper. |
| `alignCameraToView({x,y,scale,width,height}, indices)` | Fit the camera aspect ratio inside the visible canvas at its current pan and zoom. Values are local CSS pixels. Each existing camera rotation is retained. |
| `applyCameraToFigures(indices)` | Bake the inverse camera matrix into all instance roots, absolute angles and scales; retain joins and reset the camera. It does not modify reusable figure definitions. |
| `locateHandle(direction, options)` | Match a UID and native handle ID in the immediately previous (`-1`) or next (`1`) stored key. Offset the full joined component and other selected figures equally. `options` accepts `uid`, `jointIndex`, or explicit `handleId`; origin is handle 0. |
| `locateCamera(direction, channel, indices)` | Copy neighboring `position`, `rotation`, `scale`, or the complete `pose`, leaving other channels intact. |

Indices default to the current stored key. Multi-key operations use each native
key's start tick. If camera channels are authored, a single current-point edit
uses the displayed tick, including an inbetween. Range commands sample composed
camera values and create changed scalar keys atomically; existing interpolation
and other channels are preserved.

For pointer gestures, call `beginCameraDrag({indices, label})`, then
`updateCameraDrag(delta, {fromStart: true})` for each update. Delta uses the same
offset/multiplier convention as `transformCamera`. `commitDrag()` and
`cancelDrag()` dispatch to the camera lifecycle. Native gestures snapshot camera
values only. Authored gestures use temporary sparse channel keys, restore the
original table before committing, and create one history entry. Invalid updates
restore the original state.

The camera's inspector (`src/inspector-view.mjs`) places its commands: Level,
Center and Reset (`camera-level`, `camera-center`, `camera-reset`) are its quick
actions; `camera-copy` and `camera-paste` are Transform's title actions;
`camera-align-view`, `camera-center-x`, `camera-center-y`, `camera-locate-previous`,
`camera-locate-next` and `camera-apply-figures` are in the titled Framing section.
Neighbor panel buttons match the whole pose; handle-based
Locate can choose a single camera channel.

`locateHandle(direction, {editMode:true})` now delegates to the separate
pose-local fixed-point editor. Applying the camera into figures with authored
camera/figure/layer channels still needs a composed-transform baking operation
and rejects before mutation. Applying a native camera to figures preserves the
played figure appearance, but cannot preserve a moved image/gradient background:
native Pivot has the same limitation.

Verification: the recorded edit tapes (`engine/tests/edit/camera-*.scenario.json`) and the
session tests (`cargo test -p styk-edit`) state the commands; `tests/background-angle.test.mjs`
and the camera inspector's command availability in `tests/inspector-descriptors.test.mjs`
cover the view helpers. These checks do not replace the final integrated UI walkthrough.

Native references: [virtual camera](https://pivotanimator.net/help5-2/virtual_camera.htm),
[neighbor alignment](https://pivotanimator.net/help5-2/alignment_to_neighbouring_frames.htm),
[numeric values](https://pivotanimator.net/help5-2/value_input.htm).
