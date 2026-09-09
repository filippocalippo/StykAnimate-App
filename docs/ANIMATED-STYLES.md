# Authored figure and segment opacity

Style channels use the same sparse keys, hold/linear interpolation, previews, undo, and timeline timing as transform channels. They change one figure instance at a time. Ordinary native style edits still change the reusable figure definition.

| Inspector value | Animation target | Property | Channel units |
| --- | --- | --- | --- |
| Outline opacity | `{kind:'figure', uid}` | `outlineOpacity` | 0–1 |
| Segment opacity | `{kind:'segment', uid, handleId}` | `opacity` | 0–1 |
| Gradient opacity | `{kind:'segment', uid, handleId}` | `gradientOpacity` | 0–1 |

The inspector displays percentages. Segment targets use native handle IDs, not segment-array positions. Missing handles leave the channel dormant. Gradient opacity changes an existing secondary gradient endpoint; it does not create a gradient on a plain segment.

## Evaluation and storage

[animation-channels.mjs](../src/animation-channels.mjs) samples these channels into a small `_stykStyle` record on the selected evaluated object. [animation-style.mjs](../src/animation-style.mjs) resolves that record into a temporary figure definition, copying only changed segment/global-style records. Image data, embedded glyphs, unrelated segments, other instances, and source definitions retain their references.

The geometry builder resolves the temporary definition before drawing. Canvas, WebGPU vectors and compatibility textures, prepared playback, and SVG therefore consume the same native alpha fields. Native inverse transparency is `round((1 − opacity) × 255)`. Style-only changes preserve interpolated segment lengths and bends.

STYK stores editable sparse channels. Captured pose sources can also retain the small instance override. No duplicate native figure table is needed for the authored document.

## Native export

[pivot-style-materialize.mjs](../src/pivot-style-materialize.mjs) creates portable native figure variants when PIV is exported. It deduplicates variants by effective native alpha bytes and retains shared asset references while preparing the export. Baked objects reference their resulting native types and no longer carry `_stykStyle`.

STK exports the selected instance's resolved appearance at the requested tick. Unrelated instances of the original reusable figure type remain unchanged. The native figure table limit is checked explicitly; large combinations of independently animated styles can require many native types.

## Verification

- [animation-style.test.mjs](../tests/animation-style.test.mjs): eleven checks cover target/value validation, independent primary/gradient/outline interpolation, copy-on-write boundaries, native runtime pose preservation, reordered/missing handles, plain-segment behavior, joined children, sparse editor history/cancel, editable JSON round-trip, malformed captured overrides, and native alpha-only segment aliases. The style/channel/editor suite passes 36 checks.
- [pivot-style-materialize.test.mjs](../tests/pivot-style-materialize.test.mjs): native variant reuse, unchanged shared instances, captured overrides without channels, and actual PIV/STK writer/decoder round-trips.
- [animation-style.browser.mjs](../tests/animation-style.browser.mjs): 45 actual browser checks compare Canvas, live WebGPU, prepared WebGPU, and decoded SVG with independently set native alpha fields. Nine cases cover straight vector gradients, outlined figures, and curved gradients at three times. [The report](../artifacts/animation-style/report.json) and [visually inspected comparison](../artifacts/animation-style/pixels.png) preserve the results.

Captured or pasted overrides without scalar channels use a pose-local numeric edit. The adapter changes the displayed instance's existing override in one undoable edit, preserving other instances and avoiding an implicit scalar channel. [Captured override tests](../tests/captured-style-opacity.test.mjs) verify this path; Panels' actual browser workflow additionally verifies its inspector controls and timeline selection.
