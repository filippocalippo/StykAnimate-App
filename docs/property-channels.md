# Independent property channels

> **Superseded authoring model.** Current documents use the layer sheet: every
> inspector property edit writes a complete layer pose key (see
> [layer-timeline.md](layer-timeline.md)). There are no per-property key
> controls, property rows, or authored-key navigation. The channel machinery
> below remains as the compatibility surface: imported and legacy channel data
> is still evaluated, projected, and preserved on save, and the low-level
> `Editor` APIs keep working for native tools. `_styk.animation` is removed from
> the writable document when a layer sheet initializes; its channels migrate
> into sheet keys.

The app enables `Editor({propertyChannels: true})` in both Simple and Advanced
mode. Both timelines edit the same document and use the same evaluator.

Independent properties are:

| Target | Properties |
| --- | --- |
| Figure | Scale, color, opacity, outline color/width/opacity, Z-index |
| Segment | Color, opacity, width, gradient end color/opacity, fill style |
| Polygon | Color, opacity |
| Camera | X, Y, scale, rotation |
| Scene | Background asset, color |

Historically, property edits added or updated only the affected property keys
without creating a Pose key. Under the layer sheet, the same edits are routed
through `_sheetPropertyEntries`, which captures the owning layer's complete pose
at the target tick: editing a held cell edits its preceding key, and an edit
inside a tween writes a boundary at the entry's tick. Branch appearance edits
still resolve through the same target vocabulary; instance appearance edits do
not change the shared figure type.
Fill style stores gradient type, angle and stop layout. Endpoint color and opacity
have separate channels. Fill style, background asset and Z-index use Constant
interpolation; color channels interpolate color components.

The inspector calls the two spatial gradient endpoint controls **Primary opacity**
and **Secondary opacity**. These are not animation start/end settings.

Figure X/Y and rotation remain in Pose, with no separate key controls or new
transform channels. Previously saved X/Y/rotation tracks remain readable.
Pose remains responsible for position, rotation, skeleton deformation, attachment, figure presence
and native ordering. A gesture that changes both shape and properties separates
the property changes before capturing its Pose source. Joined children retain
inherited movement instead of receiving unnecessary absolute transform tracks.

## Existing documents and the two timelines

Native frames and retained Pose sources remain valid compatibility snapshots.
Their required native fields are not destructively removed. The timeline can
project property curves from these snapshots without allocating authored channels.
When a property is edited, its existing curve is adopted as a property channel;
native automatic transform easing, shortest rotation and byte opacity/color
sampling are retained until explicitly edited. New figure/layer Pose channels
retain native appearance on its original clock using `nativeProperties`;
retiming Pose therefore does not retime scale, color or opacity. Explicit scalar
channels override that baseline. This avoids eagerly generating scalar keys for
every figure and frame when the first Pose is edited.

Consequently, a scalar value can still appear inside a serialized native baseline,
but a new property edit does not author it in both that baseline and a Pose key.
This is a compatibility-preserving authoring split, not an eager rewrite of every
old snapshot. The low-level Editor default remains available for native tools and
legacy consumers that intentionally edit native frames.

The Simple filmstrip and the Advanced sheet share the same layer-sheet document;
working-frame checkpoints and stored-frame projections apply to native documents
without a layer sheet. With no figure selected, Scene and Camera are shown
together in the inspector. Undo/redo, ranges, playback and style export read the
same evaluated values regardless of which surface authored them.

## Architecture and performance

`animation-properties.mjs` supplies the shared channel vocabulary.
The engine session
authors the channels (`styk-edit`); the editor no longer projects or adopts native
curves itself.
The evaluator and style materializer compose the same per-instance values for
editing, playback and export. Topology repair retargets style channels and
preserves authored gradient orientation when a figure's origin changes.

Timeline rows hold marker metadata and references to engine keys, not copied
values. Drawing or labeling an unedited channel does not evaluate the full scene
at every key. Scalar previews reuse marker projections, while clearing sampled
values and dependency checks. Pose/timing-source changes invalidate projections.
Ordinary native fields read their immutable source snapshots directly. Joins and
cross-property dependencies use the shared evaluator, with a 64-frame cache cap.
Persisted channels always contain ordinary data; lazy getters stay in projection
objects and are materialized before entering document/history state.

The browser stress test covers 10,000 native frames, 500 figures per frame, and
200,000 authored keys as three separate workloads. Both timeline modes retained
correct Add behavior. Independent property interpolation, native save/reopen,
and marker-cache behavior have regression tests. Detailed local measurements
are recorded in `artifacts/property-channels/performance-before.json` and
`performance-after.json`; these are machine-specific observations, not universal
latency guarantees. Large bulk Add operations still do more work than a scalar
preview and are a useful candidate for future cooperative scheduling.

The updated browser measurements are in
`artifacts/timeline-sync-properties/performance-after.json`. Median Pose commits
were 14.6/5.4 ms (Advanced/Simple) for 10,000 frames, 6.5/3.3 ms for 500 figures,
and 7.0/1.1 ms for 200,000 authored keys. Mode switches measured 0.8–12.4 ms.
Adding a working frame in the largest key workload still took 124.8 ms; this
bulk operation remains a candidate for cooperative scheduling.

## Verification and next steps

`tests/property-channel-authoring.browser.mjs` exercises the actual inspector and
both timelines, including the no-selection Scene/Camera view. Its companion
`tests/timeline-sync-properties.browser.mjs` checks actual inspector edits, repeated
switches, Simple Add/Update and rendered scene pixels between color keys. The
channel authoring itself is stated by the session's recorded edit tapes and tests
(`cargo test -p styk-edit`).

A useful next step is collapsible Transform/Appearance groups and a curve editor
for each scalar property. Per-joint angle/length/bend channels could follow as a
separate rigging change, with attachment and IK tests. Any eager legacy migration
should be a dedicated conversion with before/after sampling checks rather than
silently deleting native baseline fields.
