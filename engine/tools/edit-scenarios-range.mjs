// Command-replay scenarios of the figure-range commands (docs/engine/editing.md): figures
// changed across frames (`applyFigureRange` and the `*InFrames` commands, `planFigureFrameOperation`),
// figure order (bring to front, send to back, a step up or down), joining and detaching, flipping
// a branch, and moving figures across frames. Run by engine/tools/edit-scenarios-property.mjs.
// A frame range as the app passes it on a layer sheet (an array carrying `sheetTicks`) is
// written `{"@array": [...], "sheetTicks": [...]}` (engine/tools/edit-replay.mjs).
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';

const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const scenario = (name, editor, steps, document) => writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');
const range = (sheetTicks, indices = [0]) => ({'@array': indices, sheetTicks});
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const figure = uid => ({kind: 'figure', uid});

// Colours: the figure of the polygons document with a native gradient, a three-stop paint, a
// translucent segment and a colour transition, and a smaller figure joined to its head with a
// full colour override (its own polygon).
{
  const document = JSON.parse(readFileSync(`${out}/polygons.document.json`, 'utf8'));
  const [body] = document.figure_types;
  body.segments[2].secondary = {rgb: [200, 40, 40], a: 0};
  body.segments[3].paint = {type: 'linear', angle: 0, stops: [{offset: 0, color: [10, 20, 30], opacity: 1}, {offset: 0.5, color: [100, 110, 120], opacity: 0.5}, {offset: 1, color: [250, 240, 230], opacity: 1}]};
  body.segments[4].transparency = 64;
  body.polyfills[1].polyfill_id = 7;
  const small = {...structuredClone(body), figure_type_id: 2, name: 'Small', segment_count: 3, segments: structuredClone(body.segments.slice(0, 3)),
    polyfills: [{segment_ids: [0, 1, 3], color_rgb: [13, 153, 255], alpha_raw: 0, color_alpha: 1, z_order: 0, z_order_runtime_raw: -1}]};
  delete small.segment_z_raw; delete small.poly_z_raw;
  document.figure_types.push(small);
  const frame = document.keyframes[0], [first] = frame.objects;
  first.color_transition = {from: 0, to: 0xffff0000, t: 0.25};
  const second = {...structuredClone(first), object_slot: 1, unique_id: 2, figure_type_id: 2, root_x: 600, root_y: 200, color_override_raw: 0xff00ff00,
    angles: first.angles.slice(0, 3), join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 2}};
  delete second._stykIK; delete second.color_transition;
  frame.objects.push(second);
  frame.object_draw_order = [0, 1]; frame.object_draw_order_unique_ids = [1, 2];
  if ('object_count' in frame) frame.object_count = 2;
  delete document._styk.layerSheet;
  writeFileSync(`${out}/range-colors.document.json`, mirror(open(document, app)));
}

// Two layers (figure 3 joined to 2, 2 joined to 1; 3 on the second layer; the first layer's
// first key held), with two more figures added on the first layer.
const more = [['@select', 1, -1], ['addFigure', 2], ['moveSelection', -260, 40], ['addFigure', 3], ['moveSelection', 220, 90]];
scenario('range-appearance-sheet', app, [
  ...more,
  ['selectMany', [1, 4]],
  ['updateFiguresInFrames', {field28: 100}, [0], {ticks: [0, 3]}],
  ['updateFiguresInFrames', {opacity: 0.25}, [0], {ticks: [2]}],
  ['updateFiguresInFrames', {color_override_raw: 0x80ff0000}, [0], {ticks: [0]}],
  ['updateFiguresInFrames', {field28: 100}, [0], {ticks: [0]}],
  ['updateFiguresInFrames', {opacity: 2}, [0]], ['updateFiguresInFrames', {bogus: 1}, [0]], ['updateFiguresInFrames', {opacity: 0.5, field28: 3}, [0]],
  ['updateFiguresInFrames', {field28: 7}, [0], {ticks: [2.5]}],
  ['updateFiguresInFrames', {field28: 9}, range([1, 5, 3])],
  ['undo'], ['redo'], ['undo'],
  // The app's inspector with several figures selected: the playhead's tick.
  ['selectMany', [1, 3]], ['updateFiguresInFrames', {field28: 40}, [0], {ticks: [0]}],
  ['@seek', 4], ['updateFiguresInFrames', {color_override_raw: 0xff00ff}, [0], {ticks: [4]}],
  ['undo'], ['undo'], ['redo'],
], 'sheet-layers.document.json');
// A colour override drops a colour transition.
scenario('range-appearance-colors-sheet', app, [
  ['@select', 1, -1], ['updateFiguresInFrames', {field28: 20}, [0], {ticks: [0]}], ['updateFiguresInFrames', {color_override_raw: 0x40ff8000}, [0], {ticks: [0, 2]}],
  ['selectMany', [1, 2]], ['updateFiguresInFrames', {opacity: 0.3}, [0]], ['undo'], ['undo'], ['redo'],
  // The second figure's stored root is stale: geometry places it where it is joined.
  ['@select', 1, -1], ['deleteFiguresInFrames', [0], {ticks: [0]}], ['undo'], ['@select', 2, -1], ['detachFiguresInFrames', [0], {ticks: [1]}],
  ['duplicateInFrames', [0], {ticks: [2]}], ['undo'], ['undo'],
], 'range-colors.document.json');
scenario('range-order-sheet', app, [
  ...more,
  ['@select', 4, -1], ['orderFiguresInFrames', 'back', [0], {ticks: [0, 4]}],
  ['orderFiguresInFrames', 1, [0], {ticks: [1]}], ['orderFiguresInFrames', 1, [0], {ticks: [1]}],
  ['bringToFront'], ['sendToBack'], ['moveSelectionLayer', 1], ['moveSelectionLayer', -1], ['moveSelectionLayer', 0.5],
  ['orderSelection', 'front', {}], ['orderSelection', 2], ['orderSelection', 'back', {frameIndices: [0, 1]}],
  ['selectMany', [1, 5]], ['orderFiguresInFrames', 'front', [0, 1]], ['orderFiguresInFrames', 'sideways', [0]],
  ['orderFiguresInFrames', -3, range([2, 6])], ['orderFiguresInFrames', 100000, [0], {ticks: [3]}],
  ['@select', 3, -1], ['bringToFront'], ['sendToBack'],
  ['undo'], ['undo'], ['undo'], ['redo'],
  // Depths at the limits: a move past two figures at the largest shifts the run down, past two
  // at the smallest up, and one that cannot fit between both numbers the layer's figures again.
  ['addAnimationKeys', [{target: figure(2), property: 'zIndex', tick: 0, value: 1000000}, {target: figure(4), property: 'zIndex', tick: 0, value: 1000000}]],
  ['@select', 1, -1], ['orderFiguresInFrames', 'front', [0], {ticks: [0]}],
  ['addAnimationKeys', [{target: figure(2), property: 'zIndex', tick: 0, value: -1000000}, {target: figure(5), property: 'zIndex', tick: 0, value: -1000000},
    {target: figure(4), property: 'zIndex', tick: 0, value: 0}, {target: figure(1), property: 'zIndex', tick: 0, value: 1}]],
  ['@select', 4, -1], ['orderFiguresInFrames', 'back', [0], {ticks: [0]}],
  ['addAnimationKeys', [{target: figure(1), property: 'zIndex', tick: 0, value: -1000000}, {target: figure(2), property: 'zIndex', tick: 0, value: 0},
    {target: figure(4), property: 'zIndex', tick: 0, value: 1000000}, {target: figure(5), property: 'zIndex', tick: 0, value: 1000000}]],
  ['@select', 1, -1], ['orderFiguresInFrames', 'front', [0], {ticks: [0]}], ['undo'], ['undo'],
], 'sheet-layers.document.json');
scenario('range-joins-sheet', app, [
  ...more,
  // An offset that is not a multiple of single precision's spacing: a joined copy lands where its copied parent puts it.
  ['selectMany', [2, 3]], ['duplicateFiguresInFrames', [0], {ticks: [0], offset: 0.3}], ['undo'],
  ['@select', 3, -1], ['detachFiguresInFrames', [0], {ticks: [0, 2, 5]}],
  ['joinFiguresInFrames', 2, 22, [0], {ticks: [0, 5]}],
  ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0], {ticks: [0, 2]}], ['undo'], ['@select', 3, -1],
  ['joinFiguresInFrames', 3, 0, [0]],
  ['@select', 1, -1], ['joinFiguresInFrames', 3, 11, [0]],
  ['@select', 4, -1], ['joinFiguresInFrames', 1, 99, [0]], ['joinFiguresInFrames', 1, 66, [0], {ticks: [3]}],
  ['joinFiguresInFrames', 1, 66, [0], {ticks: [3]}], ['joinFiguresInFrames', 77, 0, [0]], ['joinFiguresInFrames', -1, 0, [0]],
  ['detachFiguresInFrames', null, {uids: [4], atPlayhead: true}],
  ['@seek', 3], ['detachFiguresInFrames', null, {uids: [4], atPlayhead: true}],
  ['undo'], ['undo'], ['redo'],
  // Duplicated with their joins kept among the copies, deleted (a joined figure stays where it was drawn), added.
  ['selectMany', [2, 3]], ['duplicateInFrames', [0], {ticks: [0, 3]}],
  ['@select', 2, -1], ['deleteFiguresInFrames', [0], {ticks: [2, 4]}],
  ['addFigureInFrames', 1, [0], {ticks: [1, 5], x: 100, y: 120}], ['addFigureInFrames', 99, [0]], ['addFigureInFrames', 2, [0], {x: 'left'}],
  ['addFigureInFrames', null, range([2, 6])],
  ['undo'], ['undo'], ['undo'], ['redo'],
  ['selectMany', [1, 4]], ['duplicateFiguresInFrames', [0, 1]], ['deleteFiguresInFrames', range([0, 1])],
  ['undo'], ['undo'],
  // Moved across frames: the keyframes' starts, or the app's ticks in the order it gives them.
  ['@select', 1, -1], ['moveSelectionInFrames', 15, -5, [0, 1]], ['moveSelectionInFrames', 0, 0, [0]],
  ['moveSelectionInFrames', 4, 4, range([5, 1, 3])], ['moveSelectionInFrames', 'far', 0, [0]],
  ['@seek', 3], ['moveSelectionInFrames', 5, 5, [0]], ['@seek', 0], ['@select', 3, -1], ['moveSelectionInFrames', 7, 0, [0, 1]], ['@select', 1, -1],
  ['undo'], ['undo'], ['redo'],
  // A deleted figure's later slots move down, joins following them.
  ['@seek', 0], ['@select', 5, -1], ['joinFiguresInFrames', 4, 22, [0], {ticks: [0]}], ['@select', 2, -1], ['deleteFiguresInFrames', [0], {ticks: [0]}], ['undo'], ['undo'],
], 'sheet-layers.document.json');
scenario('range-transforms-sheet', app, [
  ...more, ['@select', 1, 2], ['updateSegment', {bend_rad: 0.6}], ['@select', 1, 1], ['updateSegment', {bend_rad: -0.4}],
  ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0], {ticks: [1, 3]}],
  ['@select', 2, -1], ['mirrorFiguresInFrames', 'vertical', [0], {ticks: [1]}], ['mirrorFiguresInFrames', 'diagonal', [0]],
  ['selectMany', [1, 4]], ['rotateFiguresInFrames', 0.3, [0], {ticks: [2, 6]}],
  ['rotateFiguresInFrames', 0, [0]], ['rotateFiguresInFrames', -0.2, [0], {center: {x: 300, y: 200}}],
  ['rotateFiguresInFrames', 0.1, [0], {center: {x: 300}}],
  ['scaleFiguresInFrames', 1.5, [0], {ticks: [2]}], ['scaleFiguresInFrames', 0.8, [0], {relative: true, ticks: [2, 4]}],
  ['scaleFiguresInFrames', -1, [0]], ['scaleFiguresInFrames', 1, [0], {relative: true}],
  ['centerFiguresInFrames', [0], {ticks: [4]}],
  ['@select', 5, -1], ['centerFiguresInFrames', [0, 1]], ['scaleFiguresInFrames', 0, [0]],
  ['selectMany', [4, 5]], ['scaleFiguresInFrames', 3, [0], {ticks: [0]}], ['@select', 5, -1], ['scaleFiguresInFrames', 2, [0]],
  ['@select', 2, -1], ['scaleFiguresInFrames', 0.5, [0], {ticks: [5]}], ['centerFiguresInFrames', [0], {ticks: [5]}],
  ['selectMany', [1, 2]], ['resetPoseInFrames', [0], {ticks: [0, 6]}], ['resetPoseInFrames', [0], {ticks: [0]}],
  ['mirrorFiguresInFrames', 'horizontal', range([4, 1])],
  ['@select', 4, -1], ['mirrorFigure', 'vertical'], ['mirrorFigure'], ['mirrorFigure', 'sideways'], ['selectMany', [4, 5]], ['mirrorFigure', 'horizontal'],
  ['undo'], ['undo'], ['undo'], ['redo'],
], 'sheet-layers.document.json');
// Auto key: every range edit keys its ticks, held cells included; a locked layer refuses.
scenario('range-autokey-sheet', {...app, autoKey: true}, [
  ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0], {ticks: [2, 3]}], ['updateFiguresInFrames', {field28: 50}, [0], {ticks: [4]}],
  ['orderFiguresInFrames', 'back', [0], {ticks: [1]}], ['undo'], ['redo'],
], 'sheet-layers.document.json');
scenario('range-locked-sheet', app, [
  ['@select', 3, -1], ['updateFiguresInFrames', {field28: 50}, [0]], ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0]],
  ['rotateFiguresInFrames', 0.2, [0]], ['@select', 2, -1], ['detachFiguresInFrames', [0]], ['updateFiguresInFrames', {field28: 50}, [0]],
], 'sheet-locked.document.json');
// Flipping a branch: the selected joint's segment turned over the horizontal or vertical,
// figures joined below it following.
scenario('range-branch-sheet', app, [
  ['@select', 1, 1], ['mirrorSelection'], ['mirrorSelection', 'vertical'], ['@select', 1, 3], ['mirrorFigure', 'horizontal'],
  ['@seek', 3], ['@select', 2, 0], ['mirrorSelection', 'horizontal'], ['@select', 2, 1], ['mirrorSelection', 'vertical', {center: {x: 10, y: 10}}],
  ['@select', 3, 2], ['mirrorSelection'], ['undo'], ['undo'], ['redo'],
  ['@select', 1, 0], ['beginDrag', 'Pose figure'], ['rotateJoint', 0.2], ['mirrorSelection'], ['undo'], ['redo'],
], 'sheet-layers.document.json');
// The same commands on a native timeline: one history entry patching the keyframes.
scenario('range-native', {}, [
  ['@select', 1, 1], ['mirrorSelection'], ['@select', 2, 0], ['mirrorSelection', 'vertical'],
  ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0, 1]], ['updateFiguresInFrames', {opacity: 0.4}, [1]],
  ['selectMany', [1, 3]], ['orderFiguresInFrames', 'back', [0, 1]], ['rotateFiguresInFrames', 0.25, [0]], ['resetPoseInFrames', [1]],
  ['@select', 3, -1], ['detachFiguresInFrames', [0]], ['joinFiguresInFrames', 2, 22, [0]],
  ['undo'], ['undo'], ['undo'], ['redo'], ['@seek', 6], ['@select', 2, 1], ['mirrorSelection'], ['undo'], ['redo'],
  ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
], 'joined-chain.document.json');
// Figures with inverse kinematics: every limb pinned, a controller across joined figures, a foot
// with followers. Geometry solves the limbs the operations measure and re-join.
const ik = name => `../../crates/styk-eval/tests/fixtures/ik/${name}.json`;
scenario('range-ik-pinned-sheet', app, [
  ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0], {ticks: [0, 4]}], ['rotateFiguresInFrames', 0.2, [0], {ticks: [2]}],
  ['scaleFiguresInFrames', 1.2, [0], {ticks: [3, 6]}], ['centerFiguresInFrames', [0], {ticks: [5]}], ['resetPoseInFrames', [0], {ticks: [0]}],
  ['duplicateInFrames', [0], {ticks: [1, 2]}], ['updateFiguresInFrames', {field28: 30}, [0], {ticks: [1]}], ['@select', 1, 3], ['mirrorSelection', 'vertical'],
  ['undo'], ['undo'], ['redo'],
], ik('startup-pinned'));
scenario('range-ik-joined-sheet', app, [
  ['@select', 1, -1], ['centerFiguresInFrames', [0], {ticks: [0, 3]}], ['@select', 3, -1], ['mirrorFiguresInFrames', 'vertical', [0], {ticks: [1, 6]}],
  ['detachFiguresInFrames', [0], {ticks: [2, 7]}], ['@select', 2, -1], ['rotateFiguresInFrames', 0.3, [0], {ticks: [4]}], ['scaleFiguresInFrames', 0.7, [0], {ticks: [4]}],
  ['selectMany', [3, 4]], ['duplicateInFrames', [0], {ticks: [0]}], ['@select', 2, -1], ['deleteFiguresInFrames', [0], {ticks: [5, 8]}],
  ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0], {ticks: [9]}], ['@select', 2, 0], ['mirrorSelection'],
  ['undo'], ['undo'], ['undo'], ['redo'],
], ik('joined'));
scenario('range-ik-followers-sheet', app, [
  ['@select', 1, -1], ['mirrorFiguresInFrames', 'horizontal', [0], {ticks: [0, 6]}], ['rotateFiguresInFrames', -0.4, [0], {ticks: [3]}],
  ['@select', 1, 1], ['mirrorSelection'], ['@select', 1, 2], ['mirrorSelection', 'vertical'], ['undo'], ['redo'],
  ['@select', 1, -1], ['moveSelectionInFrames', 12, -4, [0], {movePins: true}], ['moveSelectionInFrames', 6, 6, [0, 1]], ['undo'],
], ik('followers'));
// A document with a movieclip: the other figures change across frames as anywhere else.
scenario('range-movieclip-sheet', app, [
  ['@seek', 3], ['@select', 1, -1], ['updateFiguresInFrames', {field28: 60}, [0], {ticks: [0, 3]}], ['orderFiguresInFrames', 'back', [0], {ticks: [2]}],
  ['@select', 2, -1], ['detachFiguresInFrames', [0], {ticks: [1]}], ['rotateFiguresInFrames', 0.2, [0], {ticks: [1, 5]}], ['undo'], ['redo'],
], 'sheet-movieclip-loose.document.json');
// Recolouring (`editFigureColors` through `applyFigureRange`, src/figure-colors.mjs): a colour
// replaced through the palette of a joined assembly, gradient ends and paint stops, the whole
// figure, segment and polygon styles (a polygon's colour from the builder), a reset, ranges,
// the editor's refusals and a hidden or locked layer.
scenario('recolor-sheet', app, [
  ['@select', 1, -1], ['replaceFigureColor', '#0d99ff', '#123456'], ['replaceFigureColor', '#00ff00', '#ff00ff'], ['replaceFigureColor', '#c82828', '#204060'],
  ['replaceFigureColor', '#0a141e', '#ffffff', {targets: {segments: [{handleId: 4, stops: [0, 2]}], polygons: [7]}}],
  ['replaceFigureColor', '#999999', '#000000'], ['replaceFigureColor', '#123456', '#123456'],
  ['@select', 1, 1], ['replaceFigureColor', '#123456', '#654321'], ['@select', 1, -1],
  ['setFigureColor', '#ff8000'], ['undo'], ['setFigureColor', '#00ff00', {opacity: 0.5}], ['editFigureColors', {mode: 'all', opacity: 0.25}],
  ['editFigureColors', {mode: 'style', patch: {color: '#ff0000', opacity: 0.5, thickness: 4}, targets: {segments: [{handleId: 5, stops: []}], polygons: []}}],
  ['editFigureColors', {mode: 'style', patch: {color: '#ff0000', opacity: 0.5, thickness: 4}, targets: {segments: [{handleId: 5, stops: []}], polygons: []}}],
  ['editFigureColors', {mode: 'style', patch: {paint: {type: 'radial', angle: 0, stops: [{offset: 0, color: [255, 0, 0], opacity: 1}, {offset: 1, color: [0, 0, 255], opacity: 0.5}]}}, targets: {segments: [{handleId: 6, stops: []}]}}],
  ['editFigureColors', {mode: 'style', patch: {gradient: {color: '#00ffff', opacity: 0.4}}, targets: {segments: [{handleId: 7, stops: []}]}}],
  ['editFigureColors', {mode: 'style', patch: {gradient: null}, targets: {segments: [{handleId: 3, stops: []}]}}],
  ['editFigureColors', {mode: 'style', patch: {color: [10, 20, 30]}, targets: {segments: [], polygons: [1]}}],
  ['updatePolygon', 2, {color: '#336699'}], ['updatePolygon', 1, {color: '#996633', opacity: 0.5}],
  // Overlays read back: a polygon's colour found in the palette, a stop's opacity kept when a paint is rewritten.
  ['replaceFigureColor', '#336699', '#aabbcc'],
  ['editFigureColors', {mode: 'style', patch: {opacity: 0.3}, targets: {segments: [{handleId: 4, stops: []}], polygons: []}}], ['setFigureColor', '#00aa00'],
  ['editFigureColors', {mode: 'style', patch: {opacity: 0.3}, targets: {segments: [{handleId: 8, stops: []}], polygons: []}}],
  ['editFigureColors', {mode: 'style', patch: {gradient: {color: '#00ffff'}}, targets: {segments: [{handleId: 8, stops: []}]}}],
  // A paint given out of order with a fractional channel; the reset samples the definition's paint between its stops.
  ['editFigureColors', {mode: 'style', patch: {paint: {type: 'linear', angle: 0, stops: [{offset: 0.75, color: [250, 10.4, 10], opacity: 1}, {offset: 0.25, color: [10, 250, 10], opacity: 0.8}]}}, targets: {segments: [{handleId: 4, stops: []}]}}],
  ['resetFigureColors'], ['@select', 2, -1], ['setFigureColor', '#808080'], ['resetFigureColors'], ['@select', 1, -1],
  // A half-transparent override mixed into the colours a style edit writes for the other segments.
  ['updateFiguresInFrames', {color_override_raw: 0x80ff0000}, [0]], ['editFigureColors', {mode: 'style', patch: {thickness: 3}, targets: {segments: [{handleId: 1, stops: []}], polygons: []}}],
  ['undo'], ['undo'],
  ['setFigureColor', '#abcdef', {indices: range([0, 3])}], ['resetFigureColors', {indices: [0]}],
  // Only the figures of one definition; a three-digit hex colour.
  ['selectMany', [1, 2]], ['editFigureColors', {mode: 'all', color: '#f80', figureTypeId: 2}], ['undo'], ['@select', 1, -1],
  ['editFigureColors', {mode: 'bogus'}], ['replaceFigureColor', null, '#000000'], ['editFigureColors', {mode: 'replace', color: '#000000'}],
  ['editFigureColors', {mode: 'all', opacity: 2}], ['editFigureColors', {mode: 'style', patch: {bogus: 1}}], ['editFigureColors', {mode: 'style', patch: {paint: {type: 'spiral'}}}],
  ['editFigureColors', {mode: 'replace', color: '#000000', targets: {segments: [{handleId: 0, stops: [0]}]}}], ['setFigureColor', 'red'],
  ['setLayerLocked', 'layer-1', true], ['setFigureColor', '#000000'], ['setLayerLocked', 'layer-1', false],
  ['setLayerVisible', 'layer-1', false], ['setFigureColor', '#000000'], ['setLayerVisible', 'layer-1', true],
  ['undo'], ['undo'], ['undo'], ['redo'],
], 'range-colors.document.json');
// Format 4: the figure's colour is one override for the whole figure (a negative one draws
// black, whatever its low bytes); recolouring switches the figure to its segments' colours.
scenario('recolor-format4-sheet', app, [
  ['@select', 1, -1], ['updateFiguresInFrames', {color_override_raw: 255}, [0]], ['replaceFigureColor', '#ff0000', '#00ff00'], ['undo'],
  ['updateFiguresInFrames', {color_override_raw: -16711936}, [0]],
  ['editFigureColors', {mode: 'style', patch: {color: '#ff0000'}, targets: {segments: [{handleId: 2, stops: []}], polygons: []}}], ['undo'],
  ['setFigureColor', '#336699'], ['resetFigureColors'],
  ['editFigureColors', {mode: 'style', patch: {color: '#ff0000'}, targets: {segments: [{handleId: 2, stops: []}], polygons: []}}],
  ['undo'], ['undo'], ['redo'],
], 'format4.document.json');
// A 3D mesh's palette colours.
scenario('recolor-mesh-sheet', app, [
  ['@select', 1, -1], ['replaceFigureColor', '#d65c40', '#102030'], ['editFigureColors', {mode: 'replace', color: '#ffffff', targets: {segments: [], polygons: [], meshColors: [1, 3]}}],
  ['setFigureColor', '#808000'], ['resetFigureColors'], ['editFigureColors', {mode: 'replace', color: '#000000', targets: {segments: [], meshColors: [9]}}],
  ['undo'], ['redo'],
], '../../crates/styk-eval/tests/fixtures/spatial/mesh-sheet.json');
// On a native timeline: one history entry patching the keyframe.
scenario('recolor-native', {}, [
  ['@select', 1, -1], ['setFigureColor', '#ff0000'], ['replaceFigureColor', '#ff0000', '#00ff00'], ['resetFigureColors'], ['undo'], ['undo'], ['redo'],
], 'two-limbs.document.json');
// The figure builder and rig commands.
await import('./edit-scenarios-builder.mjs');
