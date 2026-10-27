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

The engine session's `applyCameraToFigures` (`engine/crates/styk-edit/src/camera_bake.rs`) samples all selected composed frames before changing any channel. It assigns each figure its projected world root, scaled size, and rotated pose using the existing scalar channel engine. Every member of a joined component receives the same affine transform, independent of object slot order.

Only figure `x`, `y`, `scale`, and `rotation`, plus the corresponding Camera properties, change. Adjacent integer-tick guard keys retain existing linear/hold interpolation values. A guard with `passthrough: true` restores an absent scalar override to the original native or layer-pose animation. This preserves all unselected **integer display samples** without resampling native easing curves. Fractional times between adjacent display ticks are not an equivalence guarantee.

Native keyframes, pose-channel keys, retained frame sources, figure definitions, glyphs, images, opacity, and Scene channels remain intact. No whole-frame or media snapshots are created. The staged channel table and composed poses are validated before one animation history command is published. Undo and redo restore the complete sparse channel state. Guard keys stay inside the existing duration.

Native documents retain the existing native-frame conversion path. Authored `.styk` saves retain sparse channels and source metadata. Pivot `.piv` export uses the existing worker materialization path to produce native display frames without duplicate authored overlays.

## Verification

The recorded edit tapes `engine/tests/edit/camera-bake-*.scenario.json` and the session tests (`cargo test -p styk-edit`) state the conversion; the export check is `tests/pivot-export-materialize.test.mjs`.

