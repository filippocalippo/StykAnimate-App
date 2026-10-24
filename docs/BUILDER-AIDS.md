# Builder construction aids

The integrated Builder provides three display preferences without changing the document: static-handle visibility, selected-segment highlighting, and a construction background. These preferences are stored with editor settings; scene colors and exported frames remain independent.

## Native behavior and scope

The [Pivot 5.2 manual](https://pivotanimator.net/help5-2/creating_figure_types.htm) describes F10 for static handles, F12 for highlighting, and F9 for the Builder canvas color. The supplied executable's [static evidence](../artifacts/native-static/builder-aids.md) resolves details that the manual does not specify:

- Static handles are shown by default. Hiding them preserves the selected static endpoint and a selected branch's static endpoints. Connecting a polygon or sprite, setting a pivot, and placing a duplicate need their endpoints visible.
- Highlighting defaults to off. StykAnimate draws a 1.5-screen-pixel guide in blue (`#0000ff`) for dynamic segments and `#4444cc` for static segments. Lines follow their evaluated centerline, including bends; circles, text and images receive a straight pivot connection. Artwork keeps its original color, thickness, transparency and draw order.
- The ancestor path follows straight pivot connections even when the rendered segments bend. It uses a blue stroke with a white dotted overlay, with a nominal 1.5-pixel width. Native dash-array values are `[1,1]`; browser and Direct2D edge rasterization are not claimed identical.
- Native Builder repaints selected silhouettes above its temporary figure. StykAnimate deliberately uses thin construction guides instead: repainting a full silhouette on the integrated scene overlay made selected segments appear to jump above other segments, polygons and figures. Guides and handles remain visible above artwork, but never repaint the selected artwork. Selection does not alter geometry, painter order, renderer caches, history or exported frames.
- Native saved construction colors override theme defaults. The observed native light default is `#feffff`, and its dark default is `#989999`. StykAnimate initially inherits the scene in its integrated workspace; choosing a construction color explicitly activates an independent background.

## Integration contract

`src/builder-aids.mjs` exposes `isBuilderContext`, `builderBackgroundColor`, `builderShowsStaticHandles`, `builderHighlightPath`, and `drawBuilderHighlight`. The overlay belongs immediately before handle painting and must be omitted during playback and prepared previews. The renderer accepts optional unsigned ARGB `editorBackgroundColor` for live construction display; ordinary calls leave it undefined. Canvas and WebGPU use the same override, including transparent numeric zero, and include it in matching initial-scene and retained-render keys.

`getPivotHandles` accepts `selectedJoint`, `selectedBranch`, and `builder`. These options preserve selected static endpoints and use the native Builder colors without altering ordinary animation handle behavior. Connecting tools continue to request all endpoints. Builder-only keyboard routing must leave the ordinary camera F10 command available outside Builder context.

Historical verification before the guide-only change: 26 focused Node checks passed across `tests/builder-aids.test.mjs`, `tests/canvas-interactions.test.mjs`, and `tests/renderer-initial-scene.test.mjs`. The [actual application report](../artifacts/builder-aids/report.json) records 29 passing browser checks: WebGPU/Canvas colors and restoration, SVG isolation, vector/static/text/sprite/zero-width highlights, prepared GPU buffer adoption, F9/F10/F12, selected static branch pixels, and the branch Width field with one Undo. The [preferences](../artifacts/builder-aids/preferences.png) and [Builder](../artifacts/builder-aids/builder.png) screenshots were visually inspected.

The numeric branch Width adapter also passes three focused model checks in `tests/native-branch-thickness.test.mjs`, alongside 13 existing native-property regressions. Its membership is cached once per gesture; previews change only small definition fields. Entering the selected segment's existing width still assigns that absolute width to children with different widths. Cancel restores each original value and field absence.
