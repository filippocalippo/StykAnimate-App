# Figure stacking and property keys

The figure inspector exposes **Z-index** under Stacking. Higher values draw in
front within the same user layer. Equal values preserve the pose's native draw
order. Z-index is an integer from −1,000,000 to 1,000,000, defaults to zero, and
uses Constant interpolation: the order changes exactly at the next key.

Blue diamonds indicate independent property animation. Filled diamonds mark a
key at the current frame; outlines indicate animation between keys. Values that
are only stored in pose keys have no inspector diamond or key-navigation controls.
Joint transforms have no separate keyframe controls. The inspector omits explanatory paragraphs,
key legends and subtitles.

In the app, editing an independently animatable property adds or updates its
own key at the current frame, including the first edit. Property-only edits do
not add Pose keys. Deleting the last authored key restores the native baseline;
the next property edit creates its channel again. Mixed pose gestures separate
changed properties from skeleton changes. See [Independent property channels](property-channels.md)
for the complete property list and compatibility behavior.

## Implementation

- `animation-properties.mjs` defines channel names, supported targets and
  discrete properties, shared by validation, sampling, easing and the timeline.
- `animation-property-state.mjs` derives inspector provenance without persisting
  synthetic scalar keys. It uses binary key lookup and weakly cached key facts.
- Z-index channels target stable figure UIDs. Composition writes `_stykZIndex`
  on an evaluated object using copy-on-write, retaining its geometry vectors.
  Captured poses/clipboard objects retain this small override.
- `applyLayerOrder` stably sorts depths within user layers after pose and scalar
  composition. Object slots and attachment references are never reordered.
- Authored order commands write Z-index keys directly, including tied depths,
  so independent figure poses cannot override them. Native-only editing retains
  native paint order. History and range edits remain atomic. The canvas toolbar
  provides Bring to front and Send to back for the current selection. Holding
  Shift while clicking moves the selection one step forward or backward instead.
- Worker playback and export use the same evaluator. Pivot materialization
  writes the resulting native draw order and removes the depth extension.

Regression coverage lives in `tests/figure-z-index.test.mjs` and
`tests/figure-z-index.browser.mjs`, alongside existing animation, property-control,
timeline, range-operation and clipboard checks.
