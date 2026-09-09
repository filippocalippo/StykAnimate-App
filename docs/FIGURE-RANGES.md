# Figure edits across keys

`src/editor-range-commands.mjs` provides atomic range commands. Operations identify figures by native `unique_id`, so a missing figure in an individual frame is skipped. All targets are planned and validated before the first mutation. One Undo restores the complete operation.

This follows Pivot's eligible multi-frame figure controls and proportional group scaling. Numeric positions are handled separately by `native-property-edit.mjs`; per-segment values are not range controls. References: [Figure controls](https://pivotanimator.net/help5-2/figure_controls.htm), [Value input](https://pivotanimator.net/help5-2/value_input.htm).

## Public API

All methods return `{changedFrames, changedTicks, insertedUids}`. `indices` is an array of native keyframe indices. `options.uids` defaults to the selected figures. `options.ticks` explicitly targets composed timeline ticks and takes precedence over indices.

| Method | Behavior |
| --- | --- |
| `addFigureInFrames(typeId, indices, {x, y, ...options})` | Adds one stable fresh UID in every target. |
| `pasteFiguresInFrames(indices, {offset = 0, ...options})` | Pastes the figure clipboard, merges necessary definitions once, retains internal joins, and uses stable fresh UIDs throughout the range. |
| `duplicateInFrames(indices, {offset = 24, ...options})` | Duplicates each target frame's own selected poses with a consistent fresh UID map, preserves internal joins and source layers, and leaves the clipboard untouched. `duplicateFiguresInFrames` is an alias. |
| `deleteFiguresInFrames(indices, options)` | Deletes matching UIDs; surviving attached figures detach at their visible world positions. |
| `updateFiguresInFrames(patch, indices, options)` | Sets `color_override_raw`, `field28` (native transparency byte), or `opacity` (0–1). |
| `orderFiguresInFrames(direction, indices, options)` | Accepts `front`, `back`, or signed integer steps; stays inside assigned user layers. |
| `joinFiguresInFrames(targetUid, handleId, indices, options)` | Joins at a native handle ID; missing target UIDs skip that frame, invalid joints/cycles reject the whole command. |
| `detachFiguresInFrames(indices, options)` | Detaches selected figures while retaining their world poses. |
| `mirrorFiguresInFrames(axis, indices, options)` | Mirrors horizontally or vertically; joined descendants transform once, external parents stay fixed. |
| `scaleFiguresInFrames(value, indices, options)` | Sets the reference figure's absolute scale and preserves selected proportions. `{relative: true}` instead uses a multiplier. |
| `rotateFiguresInFrames(radians, indices, options)` | Rotates each frame's selected group about its own center; attached descendants rotate once and external parents stay fixed. |
| `alignFiguresInFrames(axis, edge, indices, options)` | Aligns selected artwork with axis `x`/`y` and edge `start`/`center`/`end`, translating complete joined components. Optional `boundsOf` supplies renderer bounds. |
| `centerFiguresInFrames(indices, options)` | Centers the single selected origin or combined selected joint bounds on the stage, translating complete joined components. |
| `resetPoseInFrames(indices, options)` | Restores each selected instance's current definition angles, lengths, and bends, preserving its position, scale, appearance, and unselected attached poses. |

`applyFigureRange(operation, options)` exposes the common planner. A fully motionless operation returns zero changes and creates no history entry.

## Native and authored documents

Native keys receive sparse object-field and order patches. Appearance and ordering avoid geometry evaluation; transformations compile the affected joined subtree and necessary ancestors. Added/deleted objects require their own snapshots, while unrelated poses, definitions, and assets remain shared.

When authored channels exist, selected native rows resolve to their start ticks. Explicit ticks always edit composed state. Native source frames remain unchanged. Opacity and scale produce scalar keys without pose captures. Topology, presence, color, joins, and order produce retained pose sources for the affected layers, with changed existing scalar overrides updated so they cannot mask the edit. Unselected descendants retain independent scalar animation.

Pose captures remain larger than native field patches because they must preserve the composed source. Large batches and layer-membership animation migration are candidates for asynchronous worker planning; current layer migration has explicit allocation limits and rejects before mutation. Range commands do not claim constant cost for arbitrarily large imported scenes.
