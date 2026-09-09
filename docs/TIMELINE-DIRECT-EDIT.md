# Timeline direct editing

The selected-channel timeline now supports direct key dragging without entering a keyboard move mode. A figure row previously attempted to activate its figure ID as a layer ID, throwing before pointer selection could start. It now resolves the owning layer correctly.

- Click keys to select them and seek their frame; click empty cells to seek the exact frame.
- Drag keys or held pose blocks to move. Drag empty space to box-select; selected keys move together.
- Drop onto occupied keys to replace them on the affected channels. Undo restores both the moved and overwritten keys in one operation.
- Alt-drag copies, including onto occupied destinations. Escape cancels a drag.
- Larger hit targets choose the nearest key. Drag feedback reports replacement counts.
- Horizontal wheel/trackpad movement, Shift-wheel, middle-button panning, and native scrollbars navigate a growing timeline. Ctrl/Command-wheel zooms.
- Dragging near the viewport edges automatically scrolls; box selection also scrolls vertically.
- Clicking, scrubbing, keyboard stepping, and the frame input can navigate beyond the current animation end. Navigation does not change exported duration; placing a key extends it. The existing engine limit remains 10,000,000 ticks.

The editor's replacement and beyond-end seeking options are explicit, retaining existing behavior for callers that do not opt in.

## Verification

969 unit tests passed. Browser tests exercise selection, replacement, undo, Alt-copy, box selection, group movement, Escape cancellation, edge scrolling, distant navigation, and the actual app's native pose tracks. No browser page errors were observed. Screenshots were inspected, including `artifacts/timeline-direct-edit-app.png`.

Run the browser regression with the local server on port 47831:

`node tests/timeline-direct-edit.browser.mjs`
