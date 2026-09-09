# Animation pivots and construction origins

Set Origin re-roots a reusable native skeleton. It must not reinterpret existing
figure position, rotation, or scale curves. The editor therefore records the
original animation pivot separately from the current construction origin.

`figure._styk.animationOrigin` names the original physical pivot vertex
(`handleId`) and the original rotation reference segment (`rotationHandleId`,
`reversed`). Stable handle remapping updates these references during repeated
re-rooting. The reference orientation includes the bend when an edge reverses.

Each affected native or retained source instance stores `_stykAnimationOrigin`
with its original pivot `x` and `y`. Optional `offsetX` and `offsetY` express an
offset from the named vertex in the figure's rotation-property coordinate space.
This permits a later construction edit to move that vertex while retaining the
independent animation anchor. The effective vector from construction root to
animation pivot is:

```
native path to handle + scale × rotate(figure rotation, [offsetX, offsetY])
```

Native interpolation preserves the original virtual-rooted joint relationships,
including relative angle wrapping and easing. It interpolates the pivot
coordinates and optional local offsets using the same native parameter sampler.
The resulting construction root is the sampled pivot minus the current path
vector. Ordinary pose edits intentionally update the pivot coordinates. Shared
construction edits preserve the pivot and adjust its local offset. Style-only
edits and a pointer gesture returning to its starting pose preserve exact values.

Independent layer joins use the original physical vertex's tangent. A vertex
that becomes construction handle zero must not suddenly inherit a different
segment's orientation during layer retiming.

The helpers cache linear topology layouts and walk only the pivot path for its
vector. They do not tessellate meshes or visit unrelated figures. Definitions
without this metadata retain their existing interpolation path. Topology history
already snapshots only affected native/retained objects and their joined
descendants, so undo includes the pivot metadata without duplicating the project.

STYK persists the editable references and offsets. PIV materialization samples
corrected poses in the export worker, then removes the pivot metadata. Native
reimport therefore needs no second composition step. Unedited native documents
continue through the original byte-preserving export path.

Verification lives in `tests/editor-animation-origin.test.mjs` and
`tests/animation-origin.browser.mjs`: dense curved poses with native easing,
independent transform curves, repeated roots, retained sources and separately
retimed joined layers; actual STYK/PIV reopen; and WebGPU pixel comparisons.

## Deleting a retained reference

When Delete removes a required original vertex or angular parent, the editor
adds a bounded `animationOrigin.support` graph. Each support bone binds either
one visible native segment or a numeric ghost. The graph retains the original
angular parent basis; visible topology remains the native edited skeleton.
Instances store only removed bones' angle, bend, and signed length in the sparse
`_stykAnimationOrigin.ghosts` record. Ghosts never reach mesh generation, hit
testing, native segment counts, or visible handles.

The support `vertices` map retains physical-vertex identities. Its signed `path`
is a sum of arc vectors from the current construction root to the animation
anchor, independently of the edited parent tree. A later Set Origin prepends
the actual new-root-to-old-root path. Opposite terms cancel, unused ghost
dependencies are pruned, and validation limits the graph and path to 100,000
entries. This representation retains continuous easing, angular wrap, and
rotated/scaled offsets without baking integer timeline ticks.

Native plain Delete reconnects children to the selected parent and keeps their
pose parameters; the corresponding branch translates by the removed edge's
vector. Ctrl+Delete fits the surviving edges to their prior endpoints and merges
qualifying tangent arcs. When that fit changes an angular reference that still
exists visibly, its old dependency becomes a ghost and the fitted edge receives
a separate live support entry. Independent authored rotation and position curves
thus keep their original meaning while the construction follows native Delete
and Unsplit behavior. The static evidence and its scope are recorded in
`artifacts/native-static/builder-delete-reroot.md`.

`tests/editor-origin-support.test.mjs` checks 201 continuous samples for native
and authored animation with and without easing, branch reconnection, Unsplit
endpoints and transform curves, repeated origins, splitting, fresh instances,
exact undo/redo, and actual STYK/PIV codec roundtrips. Native export materializes
the evaluated visible poses and strips both support and ghost metadata.
