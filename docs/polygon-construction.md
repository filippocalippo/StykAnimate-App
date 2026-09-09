# Polygon construction

Polygon creation is a transient canvas operation. `PolygonDraft` copies the
figure topology once, keeps its own connection groups and never writes document
history. Ctrl-click adds the shortest segment chain as one local undo group.
Explicitly closing at the first handle, pressing Enter or clicking the active
Polygon tool commits a valid draft as one definition command. Escape, Cancel,
a tool change, frame navigation or document replacement discards construction.

`polygonPreviewPoints(evaluatedGeometry, handles, {closed})` in
[`src/polygon-preview.mjs`](../src/polygon-preview.mjs) returns world-space
boundary samples. Consecutive handles joined by a bent segment follow its
actual evaluated arc, in either direction; other pairs form straight edges.
The closing edge follows the same rule. An unfinished two-handle draft stays
open and unfilled. Edge lookup is cached per evaluated geometry object, and
neither source poses nor segment samples are mutated. The root overlay uses
these samples only for its boundary; connection markers remain on actual joints. Selected connections use Pivot red;
the first connection has a black center dot.

Duplicate polygons are compared by their ordered connection cycles, modulo
rotation and reversal. A different edge order using the same set of vertices
is allowed. This distinction follows the [native cycle audit](../artifacts/native-static/polygon-duplicate-predicate.md);
[Pivot's manual](https://pivotanimator.net/help5-2/polygon_fill.htm) describes
connection groups, closure, local undo and how consecutive bent segments shape
the polygon boundary.

Verification commands:

```powershell
node --test tests/polygon-draft.test.mjs tests/polygon-preview.test.mjs
node tests/polygon-construction.browser.mjs
```

Five preview tests compare the complete sampled outline with committed polygon
geometry for forward and reversed arcs, a curved closing edge, direct chords
and an open two-handle draft.

The [actual UI report](../artifacts/polygon-construction/report.json) contains
35 passing checks with no uncaught application errors. Its fresh source backend
first saves and reopens a real PIV, then verifies canvas clicks, grouped local
Undo/Redo, all three completion methods, cancellation, existing history
isolation and duplicate-cycle rules. Captured overlay paths exactly equal the
committed curved boundary; pixel checks verify the native connection colors.
Actual PIV/STK export buttons, backend decoding and file-picker reopening
retain the polygon connections and segment bend. The
[draft](../artifacts/polygon-construction/curved-draft.png) and
[committed result](../artifacts/polygon-construction/curved-committed.png) were
visually inspected.

During construction, destructive document shortcuts and mutation controls are
blocked, and entering timing or frame-navigation contexts cancels the draft
before those actions run. The checks cover Delete, Backspace, duplicate, Add
frame, Space, the visible Delete/Play controls and timing input. These guards
are an explicit application safety policy; the native manual does not specify
every conflicting keyboard shortcut. Browser checks cover the Windows Chrome
source build, not every desktop operating system.
