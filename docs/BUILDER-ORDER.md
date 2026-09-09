# Builder draw order and polygon opacity

Segments and polygons share one drawing sequence. Their inspector order is a
one-based position in that sequence, separate from the animation's figure layers.
The four buttons move an item to the back, backward one item, forward one item,
or to the front. The branch option includes descendant segments and polygons
whose connections all belong to that branch, including its pivot.

The implementation follows the supplied executable's
[combined-array algorithms](../artifacts/native-static/builder-z-order.md).
Front/back preserve the relative order of selected and unselected items. Numeric
input applies the same offset to selected members, compressing their spacing only
at sequence boundaries. The planner builds the result in linear time rather than
repeatedly shifting arrays. An unchanged operation creates no history entry.

Valid native order has unique integer positions. Tied authored or legacy-normalized
records use the renderer's deterministic polygon-first ordering until an actual
order edit assigns unique positions. This repair policy is not claimed as native
behavior for malformed data.

Polygon opacity is available under each polygon's **Opacity & draw order**
disclosure. Typing and label dragging update live; Escape restores the exact
previous fields. The disclosure remains open after a commit. These properties
edit the reusable definition and therefore every instance of that definition.
They do not add independent animation channels.

`editor-builder-style.mjs` exposes `moveBuilderOrder`, `setBuilderOrder`, and
`setPolygonOpacity`; `normalizeBuilderOrder` is shared with topology insertion.
The existing numeric adapter handles `segment_z_order` and
`polygon_<index>_z_order` / `polygon_<index>_opacity`. History stores changed
native fields and compressed-order metadata, without copying images, text assets,
animation frames or retained pose sources. Model validation rejects non-finite
order and invalid polygon alpha.

Verification:

- Eight order/opacity model tests, including actual PIV and STK encoding/reopen.
- Three preserved style/topology regressions and thirteen existing numeric
  property regressions also pass: 24 tests in the combined run.
- [Thirteen actual application checks](../artifacts/builder-order/report.json)
  cover visible controls, branch offsets, undo, live opacity cancellation,
  persistent disclosure/branch choice, unchanged frame references, and real
  PIV/STK Export/reopen. The [inspector screenshot](../artifacts/builder-order/inspector.png)
  was visually inspected.

The [native Builder manual](https://pivotanimator.net/help5-2/creating_figure_types.htm)
and [polygon manual](https://pivotanimator.net/help5-2/polygon_fill.htm) describe
these editing operations. Broader construction and render equivalence remain in
the full compatibility contract.
