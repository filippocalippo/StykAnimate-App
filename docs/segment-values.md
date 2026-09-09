# Segment values

Hover a segment node and press **I**, or use **Segment values** from the canvas context menu with a segment selected. The compact dialog edits angle and bend in degrees and posed segment length in pixels, independent of figure scale. Hold **R** while opening it to use Handle Edit behavior.

Drag a numeric label, type an exact value, or use arrow keys. Shift scales a scrub step by 0.1; Alt scales it by 0.01. Displayed values use three decimal places while typed precision remains in the model. Relative angle measures from the nearest incoming segment’s end tangent, including bends and joined origins. Changing the relative toggle changes the displayed reference without changing the pose.

The dialog starts one native model gesture. Individual fields preview into that gesture; only Apply commits history. Escape during a field gesture restores that field, and Escape outside the field gesture cancels the entire dialog. Cancel restores the exact original pose. Invalid lengths and nonfinite values do not enter the native model.

Copy/Paste uses Pivot’s `Angle:Bend:Length` text format. The relative toggle is a receiving UI option, not part of the clipboard payload. Native parsing accepts decimal points or commas, ignores malformed tokens, and compacts the first three numeric tokens into angle, bend and length. Partial input leaves the remaining values unchanged. Text is capped at 100 characters. If browser clipboard access is unavailable, the dialog exposes a manual text field for standard copy/paste.

The desktop dialog uses the native text clipboard bridge. Both reads and writes enforce the 100-character limit; invalid writes are rejected before replacing the OS clipboard. This does not require browser clipboard permissions.

`SegmentValuesDialog({dialog, content, editor, clipboard?, onClose?, onError?})` uses the existing modal shell. Call `open({relative?, editMode?, isolate?})` after selecting a segment and finishing previous gestures. The optional clipboard adapter exposes `readText()` and `writeText(text)`. The model transaction comes from `beginSegmentValueEdit`, `setSegmentValues`, `commitDrag` and `cancelDrag`; the dialog does not clone whole frames or implement an alternative pose solver.

Verification:

- `node tests/segment-values-dialog.browser.mjs`: [25 actual browser checks](../artifacts/segment-values-dialog/report.json), including system clipboard, partial and invalid tokens, relative angles, scrubbing, typed precision, cancellation and Handle Edit.
- `node tests/segment-values-app.browser.mjs`: [11 integrated app checks](../artifacts/segment-values-app/report.json), including I over a node, context-menu access, live previews, Apply/Undo, Escape and R + I.
- `node scripts/smoke-simple-native.mjs`: [9 native desktop checks](../artifacts/simple-native-smoke.json), including the actual Segment Values Copy/Paste buttons, a `45:0:50` OS clipboard roundtrip, and rejection of 101-character reads/writes. The harness restores the prior supported clipboard formats.
- `node --test tests/editor-handle-commands.test.mjs`: native model semantics. The [static executable audit](../artifacts/native-static/capslock-and-segment-values.md) records the native relative-angle and clipboard behavior.

Right-button dragging on a node retains Pivot’s bend gesture. The verified context-menu route uses the canvas while the desired segment remains selected.
