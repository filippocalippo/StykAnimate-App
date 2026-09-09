# Independent property channels

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

Property edits add or update only the affected property keys. They do not create
an additional Pose key. Branch appearance edits author the affected segment and
polygon channels; instance appearance edits do not change the shared figure type.
Fill style stores gradient type, angle and stop layout. Endpoint color and opacity
have separate channels. Fill style, background asset and Z-index use Constant
interpolation; color channels interpolate color components.

The inspector calls the two spatial gradient endpoint controls **Primary opacity**
and **Secondary opacity**. These are not animation start/end settings: each has
its own temporal keyframes, interpolation and key navigation in both modes.

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

Simple retains its Add/Update/Discard workflow, including property keys in its
working draft and stored-frame projection. Adding a frame carries explicit
property values into the new interval, continuing the property's easing rather
than creating a Constant interval. Explicit Constant easing is preserved. Scene
color defaults to linear interpolation, including from an unedited white background.
Advanced exposes the independent channels,
including unkeyed properties. With no figure selected, Scene and Camera are shown
together. Undo/redo, ranges, playback and style export use the same channel values.

## Architecture and performance

`animation-properties.mjs` supplies the shared channel vocabulary.
`pose-property-split.mjs` separates property changes from skeleton snapshots.
`native-property-projection.mjs` owns native curve adoption and lazy timeline
projection; `native-property-curve.mjs` preserves legacy curve behavior.
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

Run the memory guard with:

```sh
node --expose-gc scripts/benchmark-animation-memory.mjs --property-channels
```

On the September 10, 2026 run (2,000 frames, 20 figures, 40,000 initial keys),
200 position edits retained 12 history commands and 13 Pose sources. Retained heap
grew 77,504 bytes between edits 100 and 200 after explicit garbage collection.
Ordinary Pose edits target only affected figures; unrelated figures in the same
layer do not receive property tracks.

The updated browser measurements are in
`artifacts/timeline-sync-properties/performance-after.json`. Median Pose commits
were 14.6/5.4 ms (Advanced/Simple) for 10,000 frames, 6.5/3.3 ms for 500 figures,
and 7.0/1.1 ms for 200,000 authored keys. Mode switches measured 0.8–12.4 ms.
Adding a working frame in the largest key workload still took 124.8 ms; this
bulk operation remains a candidate for cooperative scheduling.

## Verification and next steps

`tests/property-channel-authoring.test.mjs` covers scalar ownership, mixed shape
gestures, camera and scene edits, per-instance styles, gradient/polygon persistence,
Simple drafts, ranges, imported curves and joined transforms.
`tests/property-channel-authoring.browser.mjs` exercises the actual inspector and
both timelines, including the no-selection Scene/Camera view.
`tests/timeline-sync-properties.test.mjs` covers Pose transform ownership, range
edits, native appearance timing, default-white color interpolation and save/reopen.
Its browser companion checks actual inspector edits, repeated switches, Simple
Add/Update and rendered scene pixels between color keys.

A useful next step is collapsible Transform/Appearance groups and a curve editor
for each scalar property. Per-joint angle/length/bend channels could follow as a
separate rigging change, with attachment and IK tests. Any eager legacy migration
should be a dedicated conversion with before/after sampling checks rather than
silently deleting native baseline fields.
