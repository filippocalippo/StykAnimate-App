# Builder sprite placement

Build → Add sprite part opens an image picker and the Sprite Placement dialog. The orange origin marks the image pivot; the red endpoint marks where another segment can connect. Drag either handle, enter whole-pixel coordinates, or select a handle and use the arrow keys for one-pixel movements. The selected handle has a black center. Coordinates, angle, and length appear above a checkerboard preview. Coincident handles cannot be accepted.

Choose attachment closes the placement dialog, then clicking an existing unlocked figure handle attaches the sprite to that definition. The target can belong to a different figure than the one initially selected. The canvas shows the precise attachment target. Escape, a tool change, or a document change cancels the pending image. Ordinary Import Sprite continues to create a separate figure immediately.

This follows the native [Adding Sprite Images](https://pivotanimator.net/help5-2/adding_sprite_images.htm) workflow. The existing image worker retains native PNG/GIF/BMP transparency and bottom-left color-key behavior. Native anchor records contain signed 32-bit integer coordinates and can lie outside the image; the dialog fits both the image and handles into its preview.

`SpritePlacementDialog.open(spriteFigure)` resolves a private placed figure or `null`. It changes no document data. `Editor.addSpriteSegment(spriteFigure, {parentId, angle})` adds its asset and segment within one topology command. It remaps existing sparse image indexes, preserves the independent text table, updates native and retained poses plus the Simple working-frame baseline, and retains external joins. Existing combined drawable order is normalized stably before the new sprite is placed in front, including imports with orders near 65535. Undo restores the original assets, order, poses, selection, and joins together.

The dialog guards queued close events and shared-dialog replacement so canceled sessions cannot close a newer dialog. Its preview uses the shared exact Pivot orange/red colors. It renders the decoded image once per requested preview frame, coalescing pointer updates through requestAnimationFrame.

Verification:

- `tests/editor-sprite-segment.test.mjs`: model behavior, rollback, capacity and native PIV/STK encode/reopen with exact embedded PNG bytes and anchors.
- `tests/sprite-placement.test.mjs`: immutable placement and native integer anchor bounds.
- `tests/sprite-placement.browser.mjs`: nine passing actual browser checks, including canvas pixels, dragging, keyboard positioning, cancellation races and narrow layout. Evidence and screenshots are under `artifacts/sprite-placement/`.
- `scripts/smoke-sprite-builder.mjs`: eight passing actual Electron checks for the complete Build/attachment flow, Undo/Redo, native PIV/STK save and reopen, dialog/Escape/tool/document cancellation, and ordinary immediate Import Sprite. Evidence: `artifacts/sprite-builder-smoke.json`; its recorded directory contains the exported files and desktop screenshots.
