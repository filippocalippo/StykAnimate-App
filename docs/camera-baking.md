# Applying Camera to Figures

The Camera inspector's **Apply camera transform to figures** action supports native Pivot frames and independently authored Camera, layer-pose, and figure-property tracks. The camera's inverse translation, uniform scale, and rotation become figure transforms, and the selected camera becomes identity. Background assets and settings are retained; the command does not convert backgrounds into figures.

For an authored document, a single-frame selection operates at the displayed tick, including an inbetween. A selection of native frame indices operates at their display start ticks. The model also accepts explicit display ticks:

```js
editor.applyCameraToFigures();
editor.applyCameraToFigures([0, 2]);
editor.applyCameraToFigures(undefined, {ticks: [5, 6, 12]});
```

The return value is the number of nonidentity display ticks converted. An identity or hidden Camera creates no history entry. Invalid ticks or transforms reject the whole plan before publication.

## Sparse conversion

[`camera-bake-authored.mjs`](../src/camera-bake-authored.mjs) samples all selected composed frames before changing any channel. It assigns each figure its projected world root, scaled size, and rotated pose using the existing scalar channel engine. Every member of a joined component receives the same affine transform, independent of object slot order.

Only figure `x`, `y`, `scale`, and `rotation`, plus the corresponding Camera properties, change. Adjacent integer-tick guard keys retain existing linear/hold interpolation values. A guard with `passthrough: true` restores an absent scalar override to the original native or layer-pose animation. This preserves all unselected **integer display samples** without resampling native easing curves. Fractional times between adjacent display ticks are not an equivalence guarantee.

Native keyframes, pose-channel keys, retained frame sources, figure definitions, glyphs, images, opacity, and Scene channels remain intact. No whole-frame or media snapshots are created. The staged channel table and composed poses are validated before one animation history command is published. Undo and redo restore the complete sparse channel state. Guard keys stay inside the existing duration.

Native documents retain the existing native-frame conversion path. Authored `.styk` saves retain sparse channels and source metadata. Pivot `.piv` export uses the existing worker materialization path to produce native display frames without duplicate authored overlays.

## Verification

```powershell
node --test tests/camera-bake-authored.test.mjs tests/editor-camera.test.mjs tests/pivot-export-materialize.test.mjs
node tests/camera-bake-export.browser.mjs
```

The model suite covers independently retimed layers, mixed linear/hold/late-start/passthrough scalar channels, an arbitrarily ordered three-level joined rig, nonlinear native easing, disappearing figures, zero-scale figures, adjacent and repeated conversions, duration boundaries, invalid atomic batches, and one-step undo/redo. It compares all 24 display frames, including unselected numeric samples at a `1e-9` tolerance. Existing native camera and native Pivot materialization regressions also run.

The model/native suite passes 32 checks. The browser test passes 9 integrated checks with a fresh local codec service, actual Camera inspector and Save/Export buttons, and WebGPU output before conversion and after real PIV encode/decode. All 24 fixture frames preserve the projected scene, with maximum mean channel difference `0.0352 / 255`; `.styk` sparse keys and retained sources roundtrip exactly.

Portable native text and legacy sprites are checked separately from the vector/curve fixture. Native `text_bike.piv` retains its embedded glyph asset and projected joints within `0.000026` source pixels. Its mean channel difference is `0.3534 / 255`; every significant differing pixel lies within two pixels of a reference edge. Legacy `sprite_demo.piv` retains eight image assets through PIV 4→5 conversion, with maximum projected-joint difference `0.000075` source pixels and maximum mean channel difference `0.1976 / 255`. At least `99.65%` of significant sprite differences are near reference edges. Baking rotation changes the compatibility texture's sampling grid, so pixel equality is not claimed for rerasterized media.

Evidence is written to [`artifacts/camera-bake-authored/`](../artifacts/camera-bake-authored/), including the report, native files, and original/reopened frames. These checks establish the covered camera conversion behavior, not an unrestricted zero-lag or full Pivot-parity claim.
