// Command-replay scenarios of the figure builder and rig commands (docs/engine/editing.md):
// segment styles, branch caps and circle fills, the figure's name and outline (one
// `native-properties` or `figure` history entry, or recoloured and keyed on the figure on show
// as the app does it). Run by engine/tools/edit-scenarios-range.mjs.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {documentOf, open} from './fixture-kit.mjs';

const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const scenario = (name, editor, steps, document) => writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');

// A figure of every builder shape: a line with native flag bits (11), a line with a native
// gradient (22), a circle (33), a square line with a paint (44), a filled and a clear circle
// (55, 66), a translucent line (77); polygons over the first branch (one without an identity)
// and over the circles.
{
  const document = documentOf([[
    [11, 0, 90, -0.8, {flag_bits: {raw: 0, low_byte: 0, high_byte: 0, set_bits: [], is_static: false}}],
    [22, 11, 80, -1.6, {secondary: {rgb: [200, 40, 40], a: 0}}],
    [33, 22, 30, -1.4, {primitive_code: 1, segment_kind: 'circle', segment_type: 'circle', flags: 1}],
    [44, 0, 70, 2.4, {primitive_code: 6, segment_kind: 'squareLine', flags: 6, bend_rad: 0.5,
      paint: {type: 'linear', angle: 0, stops: [{offset: 0, color: [43, 43, 43], opacity: 1}, {offset: 1, color: [10, 120, 240], opacity: 0.5}]}}],
    [55, 44, 60, 1.6, {primitive_code: 3, segment_kind: 'circleFill', segment_type: 'circle', flags: 3}],
    [66, 55, 20, 0.4, {primitive_code: 4, segment_kind: 'circleClear', segment_type: 'circle', flags: 4}],
    [77, 22, 30, -0.5, {transparency: 64, color_alpha: 1 - 64 / 255}],
  ]], () => [300, 220]);
  document.figure_types[0].polyfills = [
    {segment_ids: [0, 11, 22], color_rgb: [40, 80, 120], alpha_raw: 0, color_alpha: 1, z_order: 0, z_order_runtime_raw: -1},
    {polyfill_id: 5, segment_ids: [11, 22, 77], color_rgb: [200, 160, 40], alpha_raw: 32, color_alpha: 1 - 32 / 255, z_order: -1, z_order_runtime_raw: -2},
    {polyfill_id: 6, segment_ids: [44, 55, 66], color_rgb: [20, 200, 90], alpha_raw: 0, color_alpha: 1, z_order: -2, z_order_runtime_raw: -3},
  ];
  writeFileSync(`${out}/builder.document.json`, JSON.stringify(document) + '\n');
}
// Segment styles as the app edits them: shapes and the construction flag in the definition,
// colours recoloured and opacity and thickness keyed on the figure on show; branch caps and
// circle fills; the figure's name and outline; refusals; a pose gesture committed first.
scenario('builder-styles-sheet', app, [
  ['@select', 1, 2], ['convertSegment', 'circleFill'], ['convertSegment', 'circleFill'], ['convertSegment', 'bogus'], ['convertSegment', 6],
  ['@select', 1, 0], ['convertSegment', 'squareLine'], ['updateBuilderSegmentStyle', {static: true}], ['updateBuilderSegmentStyle', {static: 'yes'}],
  ['updateBuilderSegmentStyle', {thickness: 3, shape: 'line'}], ['updateBuilderSegmentStyle', {shape: 'circle'}, {branch: true}],
  ['updateBuilderSegmentStyle', {opacity: 0.5}], ['updateBuilderSegmentStyle', {opacity: 0.4}, {branch: true}], ['updateBuilderSegmentStyle', {thickness: 9}],
  ['updateBuilderSegmentStyle', {color: '#ff0000'}],
  ['@select', 1, 1], ['updateBuilderSegmentStyle', {gradient: {color: '#00ff00', opacity: 0.5}}],
  ['updateBuilderSegmentStyle', {paint: {type: 'radial', angle: 0, stops: [{offset: 0, color: [255, 0, 0], opacity: 1}, {offset: 1, color: [0, 0, 255], opacity: 0.5}]}}, {branch: true}],
  ['updateBuilderSegmentStyle', {bogus: 1}], ['updateBuilderSegmentStyle', null], ['updateBuilderSegmentStyle', {}, {branch: 'x'}], ['updateBuilderSegmentStyle', {opacity: 2}],
  ['updateBuilderSegmentStyle', {}], ['@select', 1, 5], ['updateBuilderSegmentStyle', {opacity: 1, thickness: 6}], ['@select', 1, 1], ['updateSegmentStyle', {shape: 'squareLine'}], ['updateSegmentBranchStyle', {static: true}],
  ['@select', 1, 3], ['setBranchCaps'], ['setBranchCaps', true], ['setBranchCaps', 'x'],
  ['@select', 1, 4], ['setBranchFill'], ['setBranchFill', 'circle'], ['setBranchFill', 'line'], ['@select', 1, 0], ['setBranchFill'],
  ['setPolygonOpacity', 1, 0.3], ['setPolygonOpacity', 1, 3],
  ['updateFigureStyle', {name: '  Hero  '}], ['updateFigureStyle', {name: ' '}], ['updateFigureStyle', {name: 'Hero'}],
  ['updateFigureStyle', {name: 'Hero', outlineWidth: 2.5, outlineColor: '#102030', outlineOpacity: 0.5}],
  ['@select', 1, -1], ['convertSegment', 'line'], ['setBranchCaps', true],
  ['@select', 1, 6], ['beginDrag', 'Pose joint'], ['rotateJoint', 0.3], ['convertSegment', 'circle'],
  ['undo'], ['undo'], ['undo'], ['redo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
], 'builder.document.json');
// On a native timeline without property channels every style edit is the definition's: colours
// with their gradient ends and paints, polygons of a branch, a polygon's opacity, the outline.
scenario('builder-styles-native', {}, [
  ['@select', 1, 1], ['updateBuilderSegmentStyle', {color: '#ff0000'}], ['updateBuilderSegmentStyle', {color: [200, 40, 40], opacity: 1}],
  ['updateBuilderSegmentStyle', {gradient: {color: '#00ff00'}}], ['updateBuilderSegmentStyle', {gradient: {opacity: 0.6}}], ['updateBuilderSegmentStyle', {gradient: null}], ['updateBuilderSegmentStyle', {gradient: {opacity: 0.25}}],
  ['updateBuilderSegmentStyle', {gradient: {bogus: 1}}], ['updateBuilderSegmentStyle', {gradient: 5}], ['updateBuilderSegmentStyle', {gradient: false}],
  ['updateBuilderSegmentStyle', {opacity: 0.5}, {branch: true}],
  ['@select', 1, 0], ['updateBuilderSegmentStyle', {color: '#0000ff', opacity: 0.8}, {branch: true}], ['updateBuilderSegmentStyle', {opacity: 0.8}],
  ['@select', 1, 3], ['updateBuilderSegmentStyle', {color: '#123456'}], ['updateBuilderSegmentStyle', {gradient: {color: '#ffffff', opacity: 0.1}}], ['updateBuilderSegmentStyle', {gradient: null}],
  ['updateBuilderSegmentStyle', {paint: {type: 'linear', angle: 45, stops: [{offset: 1, color: [0, 0, 255], opacity: 0.5}, {offset: 0, color: [255, 0, 0.4], opacity: 1}]}}],
  ['updateBuilderSegmentStyle', {paint: {type: 'spiral'}}], ['updateBuilderSegmentStyle', {paint: {type: 'solid', stops: [{offset: 0, color: [1, 2, 3], opacity: 0.5}]}}],
  ['updateBuilderSegmentStyle', {thickness: 0}], ['updateBuilderSegmentStyle', {thickness: -1}],
  ['@select', 1, 6], ['updateBuilderSegmentStyle', {thickness: 0}], ['updateBuilderSegmentStyle', {thickness: 4, static: false}], ['updateBuilderSegmentStyle', {static: true, shape: 'circle'}], ['updateBuilderSegmentStyle', {static: false}],
  ['setPolygonOpacity', 0, 0.25], ['setPolygonOpacity', 9, 0.5], ['setPolygonOpacity', 0, 0.25], ['setPolygonOpacity', 2, 1], ['setPolygonOpacity', 2, 0.5],
  ['updateFigureStyle', {outlineWidth: 3}], ['updateFigureStyle', {outlineColor: 'red'}], ['updateFigureStyle', {outlineOpacity: 0.3}], ['updateFigureStyle', {color: 1}],
  ['updateFigureStyle', {outlineColor: [9, 8, 7], outlineWidth: 1e7}],
  ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'],
], 'builder.document.json');
// A figure whose colour is overridden is recoloured on its frame even without property channels.
scenario('builder-styles-override-native', {}, [
  ['@select', 1, -1], ['updateFiguresInFrames', {color_override_raw: 0x80ff0000}, [0]], ['@select', 1, 1], ['updateBuilderSegmentStyle', {color: '#00ff00'}],
  ['updateBuilderSegmentStyle', {opacity: 0.5}], ['updateBuilderSegmentStyle', {static: true, color: '#0000ff'}], ['undo'], ['undo'], ['redo'],
], 'builder.document.json');

// Rig relationships of the rig document's figure (a stretch driver 22 with a follower 33, an
// angle-locked 44, a connector 56 from 33 to 55): Smart Stretch, behaviours merged into a joint
// (stretch, response, attachment, follow, weighted joints, angle paths, connectors), angle locks
// measured on the figure on show, a second angle reference, parts bound to a driver; the rig's
// refusals; a pose gesture committed first; history.
const rigSteps = [
  ['@select', 1, 0], ['enableSmartStretch', true], ['@select', 1, 4], ['enableSmartStretch', true],
  ['@select', 1, 1], ['setRigBehavior', {stretch: {min: 0.5, width: 'scale'}}], ['setRigBehavior', {stretch: {min: 200}}], ['setRigBehavior', {bogus: 1}],
  ['setRigBehavior', {connector: {start: 11}}], ['setRigBehavior', {response: {mode: 'rigid'}}], ['setRigBehavior', {response: {multiplier: 2}}],
  ['setRigBehavior', {response: {mode: 'bounce'}}], ['setRigBehavior', {response: null}], ['setRigBehavior', {orientation: 'world'}], ['setRigBehavior', {orientation: 'sideways'}],
  ['setRigBehavior', {stretch: null}],
  ['@select', 1, 2], ['setRigBehavior', {follow: {driver: 11}}], ['setRigBehavior', {follow: {influence: 9}}], ['setRigBehavior', {follow: {driver: 44}}], ['setRigBehavior', {follow: null}],
  ['setRigBehavior', {weighted: {origin: 22, anchors: [{joint: 55, weight: 0.5}]}}], ['setRigBehavior', {weighted: {anchors: [{joint: 55, weight: 500}]}}], ['setRigBehavior', {weighted: null}],
  ['setRigBehavior', {anglePath: {driver: 11, origin: 0, restAngle: 0, pitchRestAngle: 0, figureRestAngle: 0, keys: [[0, 10, 0, 0], [3, 0, 10, 0]]}}],
  ['setRigBehavior', {anglePath: {keys: [[3, 0, 0, 0], [1, 0, 0, 0]]}}], ['setRigBehavior', {anglePath: null}],
  ['setRigBehavior', {weighted: {origin: 22, anchors: [{joint: 55, weight: 0.5}, {joint: 55, weight: 0.5}]}}], ['enableSmartStretch', true], ['undo'],
  ['@select', 1, 5], ['setRigBehavior', {connector: null}], ['setRigBehavior', {connector: {end: 999}}], ['setRigBehavior', {connector: {end: 44}}],
  ['setRigBehavior', {stretch: {}}], ['setRigBehavior', {stretch: {source: 'slide'}}], ['setRigBehavior', {stretch: {source: 'slide', restPosition: 0.4}}],
  ['setRigBehavior', {angleLock: {mode: 'world', angle: 0, multiplier: 1}}],
  ['@select', 1, 3], ['updateBuilderSegmentStyle', {static: true}], ['@select', 1, 4], ['setAngleLock', 'parent'], ['undo'],
  ['@select', 1, 4], ['setAngleLock', 'world'], ['rotateFigure', 0.3], ['setAngleLock', 'figure'], ['setAngleLock', 'parent'], ['rotateFigure', -0.2],
  ['setSecondaryAngleReference', 11], ['setSecondaryAngleReference', 999], ['@select', 1, 0], ['poseJoint', 400, 250, {stretch: true}], ['@select', 1, 4],
  ['setRigBehavior', {angleLock: {space: 'authored'}}], ['setSecondaryAngleReference', 22], ['setSecondaryAngleReference', 0],
  ['setAngleLock', 'bogus'], ['setAngleLock', 'off'],
  ['@select', 1, 0], ['setAngleLock', 'parent'], ['setSecondaryAngleReference', 22],
  ['@select', 1, 3], ['bindStretchParts', 11], ['bindStretchParts', 11, {branch: true, mode: 'rigid', influence: 2}], ['bindStretchParts', 0], ['bindStretchParts', 55, {influence: 3}], ['@select', 1, 0], ['bindStretchParts', 11],
  ['enableSmartStretch', false], ['@select', 1, -1], ['setRigBehavior', {orientation: 'world'}],
  ['@select', 1, 1], ['beginDrag', 'Pose joint'], ['rotateJoint', 0.2], ['setRigBehavior', {orientation: 'inherit'}],
  ['undo'], ['undo'], ['undo'], ['redo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
];
scenario('rig-behavior-sheet', app, rigSteps, 'rig.document.json');
scenario('rig-behavior-native', {}, rigSteps, 'rig.document.json');
// Topology: segments added and drawn as a chain (taking their parent's colour and width as
// shown), deleted alone (Delete and Ctrl+Delete, which refits the children to the joints they
// reached) or with their branch, flipped, moved in the hierarchy, split and duplicated; style
// overlays and polygons follow the handles; refusals; history.
const topologySteps = [
  ['@select', 1, 1], ['updateBuilderSegmentStyle', {opacity: 0.5}], ['updateBuilderSegmentStyle', {color: '#cc3311'}],
  ['addSegment', {length: 40, angle: 0.5}], ['addSegments', [{length: 30, angle: 1}, {length: 20, angle: 1.5, type: 'circle'}]],
  ['addSegment', {length: -1}], ['addSegment', {type: 'image'}], ['addSegment', {parentId: 999}], ['addSegment', {length: 'x'}], ['addSegments', []],
  ['addSegment', {parentId: 0, length: 25, angle: -1, thickness: 3, type: 'squareLine'}],
  ['@select', 1, 6], ['deleteSingleSegment'], ['deleteSingleSegment', {preserveEndpoints: 'x'}],
  ['@select', 1, 1], ['splitSegment', 0.25], ['@select', 1, 1], ['unsplitSegment'],
  ['@select', 1, 3], ['mirrorSegment', 'horizontal'], ['mirrorSegmentBranch', 'vertical'], ['mirrorSegment', 'diagonal'], ['@select', 1, 0], ['mirrorSegment'],
  // A bent pose split in two is a smooth pair of arcs: unsplitting it merges their bends again.
  ['@select', 1, 4], ['updateSegment', {bend_rad: 0.6}], ['splitSegment', 0.5], ['unsplitSegment'], ['@select', 1, 4], ['duplicateSegment', {flip: true}], ['@select', 1, 3],
  ['moveBuilderSegment', 66, {parentId: 11}], ['moveBuilderSegment', 11, {parentId: 66}], ['moveBuilderSegment', 44, {parentId: 0, beforeId: 11}],
  ['moveBuilderSegment', 999, {}], ['moveBuilderSegment', 55, {parentId: 999}],
  ['@select', 1, 0], ['splitSegmentBranch'], ['splitBuilderSegments', {fraction: 2}], ['splitBuilderSegments', {branch: 'x'}],
  ['duplicateSegment', {}], ['duplicateSegmentBranch', {angleOffset: 0.4, flip: true}], ['duplicateSegment', {parentId: 999}], ['duplicateSegment', {flip: 'y'}],
  ['@select', 1, 2], ['deleteSegment', {}], ['deleteSegment', {handleIds: [999]}],
  ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'],
];
scenario('topology-sheet', app, topologySteps, 'builder.document.json');
scenario('topology-native', {}, topologySteps.slice(2), 'builder.document.json');
// The actual builder button/shortcut calls splitBuilderSegments directly with .5.
// Assert the real Editor succeeds before recording its ordinary sheet contract;
// the reference still comes solely from edit-replay.mjs, including the shown frames.
{
  const editor = open(JSON.parse(readFileSync(`${out}/builder.document.json`, 'utf8')), app), steps = [], events = [];
  editor.addEventListener('change', event => events.push(event.detail));
  const report = () => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value);
  const initial = report(), initialHistory = editor._undo.length;
  const run = (method, ...args) => {
    steps.push([method, ...args]); events.length = 0;
    if (method === '@frame') return editor.evaluatedFrame;
    return editor[method === '@select' ? 'select' : method](...args);
  };
  for (const call of [
    ['splitBuilderSegments', {branch: false, fraction: .5}],
    ['splitBuilderSegments', {branch: true, fraction: .5}],
    ['splitSegment', .5], ['splitSegmentBranch', .5],
  ]) {
    run('@select', 1, 1);
    const beforeSelection = editor._selectionState(), count = editor.figure.segments.length;
    assert.equal(run(...call), true, `${call[0]} must be a successful split`);
    assert.ok(editor.figure.segments.length > count);
    assert.equal(editor._undo.length, initialHistory + 1);
    assert.equal(editor._undo.at(-1).kind, 'topology');
    assert.equal(events.length, 1); assert.equal(events[0].kind, 'edit');
    assert.equal(events[0].structural, true); assert.equal(events[0].definition, true);
    const after = report(), afterSelection = editor._selectionState();
    run('@frame'); run('undo');
    assert.equal(report(), initial); assert.deepEqual(editor._selectionState(), beforeSelection);
    run('redo'); assert.equal(report(), after); assert.deepEqual(editor._selectionState(), afterSelection);
    run('@frame'); run('undo'); assert.equal(report(), initial);
  }
  for (const [options, key] of [
    [{fraction: 2}, 'errors.editorBuilderBranch.splitFractionMustBeBetweenZeroAndOne'],
    [{branch: 'x'}, 'errors.editorBuilderBranch.chooseWhetherToSplitTheWholeBranch'],
  ]) {
    const selection = editor._selectionState(), undo = editor._undo.length, redo = editor._redo.length;
    assert.throws(() => run('splitBuilderSegments', options), error => error.messageKey === key);
    assert.equal(report(), initial); assert.deepEqual(editor._selectionState(), selection);
    assert.equal(editor._undo.length, undo); assert.equal(editor._redo.length, redo); assert.equal(events.length, 0);
  }
  run('@select', 1, -1); assert.equal(run('splitBuilderSegments', {branch: false, fraction: .5}), false);
  assert.equal(events.length, 0); run('@select', 1, 1);
  assert.equal(report(), initial); assert.equal(editor._undo.length, initialHistory); assert.equal(editor.canUndo, false);
  assert.equal(steps.length, 33);
  scenario('builder-split-sheet', app, steps, 'builder.document.json');
}
// Figures joined to a removed handle stay where they were drawn; figures joined below a flipped
// or refitted segment are placed again on its handle.
scenario('topology-joined-sheet', app, [
  ['@select', 1, 2], ['deleteSingleSegment'], ['undo'], ['@select', 2, 1], ['mirrorSegment', 'vertical'], ['@select', 2, 1], ['unsplitSegment'],
  ['@seek', 6], ['@select', 1, 1], ['deleteSegment', {}], ['@select', 2, 0], ['splitSegment', 0.5], ['undo'], ['undo'], ['undo'], ['redo'],
], 'joined-chain.document.json');
scenario('topology-joined-native', {}, [
  ['@select', 1, 2], ['deleteSingleSegment'], ['undo'], ['@select', 2, 1], ['mirrorSegment', 'vertical'], ['@select', 2, 1], ['unsplitSegment'],
  ['@select', 1, 1], ['deleteSegment', {}], ['undo'], ['undo'], ['redo'],
], 'joined-chain.document.json');
// Inverse-kinematics controllers follow their handles: a chain split, a hand gaining a part, a
// removed end dropping its controller.
// Followers a controller captured keep their offsets; new ones are taken from the pose.
{
  const document = JSON.parse(readFileSync(`${out}/ik-settings-followers.document.json`, 'utf8'));
  for (const frame of document.keyframes) for (const object of frame.objects) object._stykIK['22'].followers = {33: 0.25, 35: 1.25};
  writeFileSync(`${out}/topology-followers.document.json`, JSON.stringify(document) + '\n');
}
scenario('topology-followers-sheet', app, [
  ['@select', 1, 0], ['addSegment', {length: 12, angle: 0.3}], ['@select', 1, 3], ['splitSegment', 0.5], ['@select', 1, 8], ['deleteSingleSegment'], ['undo'], ['undo'], ['redo'],
], 'topology-followers.document.json');
scenario('topology-ik-sheet', app, [
  ['@select', 1, 2], ['splitSegment', 0.5], ['@select', 1, 4], ['addSegment', {length: 15, angle: 0.2}], ['@select', 1, 6], ['deleteSingleSegment'],
  ['@select', 1, 8], ['unsplitSegment'], ['@select', 1, 0], ['duplicateSegmentBranch', {}], ['undo'], ['undo'], ['undo'], ['redo'],
], 'startup.document.json');
// Rigs: deleting a stretch driver its parts follow is refused (and changes nothing), a branch
// duplicated with its relationships renamed, joints appended (a connector between two handles as
// they are on show, a weighted joint), refusals, an angle-locked joint flipped.
scenario('topology-rig-sheet', app, [
  ['@select', 1, 1], ['deleteSingleSegment'], ['duplicateSegmentBranch', {}], ['undo'],
  // The committed draft kept on show after a gesture is evaluated again after a topology edit.
  ['@select', 1, 2], ['beginDrag', 'Pose joint'], ['rotateJoint', 0.2], ['commitDrag'], ['@select', 1, 4], ['splitSegment', 0.5], ['addConnector', 11, 33], ['undo'], ['undo'],
  ['@select', 1, 0], ['addConnector', 11, 55, {position: 0.3}], ['addConnector', 11, 11], ['addConnector', 11, 999], ['addConnector', 11, 55, {position: 2}],
  ['addWeightedJoint', 11, [{joint: 55, weight: 0.5}]], ['addWeightedJoint', 11, [{joint: 999, weight: 1}]],
  ['@select', 1, 3], ['splitSegment', 0.5], ['mirrorSegment', 'horizontal'], ['@select', 1, 4], ['unsplitSegment'],
  ['undo'], ['undo'], ['undo'], ['redo'], ['undo'], ['undo'],
], 'rig.document.json');
// Effect stacks on a node and Stick Nodes shapes follow the handles they name.
scenario('topology-vfx-sheet', app, [
  ['@select', 1, 2], ['splitSegment', 0.5], ['@select', 1, 4], ['deleteSingleSegment'], ['@select', 1, 1], ['duplicateSegment', {}], ['undo'], ['undo'], ['redo'],
], 'figure-vfx.document.json');
scenario('topology-sticknodes-sheet', app, [
  ['@select', 1, 1], ['splitSegment', 0.4], ['@select', 1, 3], ['deleteSingleSegment'], ['@select', 1, 0], ['mirrorSegmentBranch', 'horizontal'], ['undo'], ['undo'], ['redo'],
], 'sticknodes.document.json');
// Rig edits by dragging, on the rig document: a joint repositioned (its children refitted), a
// branch turned, a joint turned alone and stretched, an angle-locked joint stretched along its
// chord, a connector slid, a joint bent with its branch, a step back at the start, cancels, a
// gesture without a change, refusals; each commit one topology entry of the definition.
const rigDragSteps = [
  // A follower that does not deform keeps its pose when its parent's joint moves.
  ['@select', 1, 2], ['setRigBehavior', {follow: {mode: 'rigid'}}],
  ['@select', 1, 1], ['beginRigDrag', {}], ['editRigJoint', 340, 300], ['editRigJoint', 345, 310], ['commitRigDrag'], ['@select', 1, 2], ['editRigJoint', 372, 335],
  // A step that turns fewer joints than the last puts the others back.
  ['@select', 1, 0], ['beginRigDrag', {reposition: false}], ['editRigJoint', 335, 235], ['editRigJoint', 332, 238, {isolate: true}], ['commitDrag'],
  // A bend gesture without a change records nothing.
  ['@select', 1, 4], ['beginRigDrag', {bend: true}], ['commitDrag'],
  ['@select', 1, 0], ['editRigJoint', 330, 240, {reposition: false}],
  ['beginRigDrag', {reposition: false}], ['editRigJoint', 320, 245, {isolate: true}], ['editRigJoint', 318, 250, {stretch: true, isolate: true}], ['commitDrag'],
  ['@select', 1, 3], ['editRigJoint', 240, 190, {stretch: true}],
  ['@select', 1, 5], ['beginRigDrag', {}], ['editRigJoint', 300, 290], ['commitDrag'],
  ['@select', 1, 4], ['beginRigDrag', {bend: true}], ['bendJoint', 255, 262], ['bendJoint', 250, 265, {stretch: true}], ['commitDrag'],
  ['@select', 1, 2], ['beginRigDrag', {}], ['editRigJoint', 'x', 0], ['beginRigDrag', {}], ['editRigJoint', 370, 320], ['cancelRigDrag'],
  ['beginRigDrag', {}], ['editRigJoint', 365, 330], ['cancelDrag'], ['beginRigDrag', {}], ['commitRigDrag'], ['commitRigDrag'], ['cancelRigDrag'],
  ['beginRigDrag', {}], ['editRigJoint', 360, 320], ['@select', 1, 1], ['undo'],
  ['undo'], ['undo'], ['redo'], ['undo'], ['undo'], ['undo'], ['redo'],
];
scenario('rig-drag-sheet', app, rigDragSteps, 'rig.document.json');
scenario('rig-drag-native', {}, rigDragSteps, 'rig.document.json');
// The Rig tool on a figure without relationships: the definition and every pose follow.
scenario('rig-drag-plain-sheet', app, [
  // A stretched pose: the definition and the other poses take the stretch as a ratio.
  ['@select', 1, 1], ['updateSegment', {length: 120}], ['editRigJoint', 360, 110, {reposition: false, stretch: true}],
  // A static joint bent with the branch below it.
  ['updateBuilderSegmentStyle', {static: true}], ['beginRigDrag', {bend: true}], ['bendJoint', 365, 125], ['commitDrag'],
  ['@select', 1, 1], ['beginRigDrag', {}], ['editRigJoint', 330, 120], ['commitRigDrag'], ['@select', 1, 3], ['editRigJoint', 230, 260, {reposition: false, stretch: true}],
  ['@select', 1, 6], ['beginRigDrag', {bend: true}], ['bendJoint', 350, 120], ['commitDrag'], ['undo'], ['undo'], ['redo'],
], 'builder.document.json');
// A definition replaced (the text editor's apply, the builder's discard): poses keep their
// handles' offsets (a stretched and a bent pose included), a removed handle's joined figure stays
// where it was drawn; refusals; history.
{
  const builder = JSON.parse(readFileSync(`${out}/builder.document.json`, 'utf8')).figure_types[0];
  const replaced = {...structuredClone(builder), name: 'Replaced', segments: builder.segments.filter(s => s.segment_id !== 77)
    .map(s => s.segment_id === 22 ? {...s, angle_rad: s.angle_rad + 0.3, length: 60, bend_rad: 0.2} : s)};
  replaced.segments.push({...structuredClone(builder.segments[0]), segment_id: 99, parent_id: 33, length: 25, angle_rad: 0.4});
  scenario('replace-definition-sheet', app, [
    ['@select', 1, 1], ['updateSegment', {length: 45}], ['updateSegment', {bend_rad: 0.3}], ['@select', 1, 6],
    ['replaceFigureDefinition', 1, replaced], ['replaceFigureDefinition', 99, replaced], ['replaceFigureDefinition', 1, {segments: []}],
    ['replaceFigureDefinition', 1, replaced, {label: 'Edit text'}], ['undo'], ['undo'], ['redo'],
  ], 'builder.document.json');
  const chain = JSON.parse(readFileSync(`${out}/joined-chain.document.json`, 'utf8')).figure_types[0];
  const trimmed = {...structuredClone(chain), segments: chain.segments.filter(s => s.segment_id !== 33)};
  scenario('replace-definition-joined-native', {}, [
    ['@select', 1, 5], ['replaceFigureDefinition', 1, trimmed], ['undo'], ['redo'],
  ], 'joined-chain.document.json');
}
// The figure's own drawing order: segments and polygons raised and lowered (alone or with their
// branch), moved to a place, a selected segment ordered as the timeline's order commands do;
// keyed on the figure on show in the app, written into the definition on a native timeline.
const orderSteps = [
  ['@select', 1, 1], ['moveBuilderOrder', {kind: 'segment'}, 'front'], ['moveBuilderOrder', {kind: 'segment'}, 'up', {branch: true}], ['moveBuilderOrder', {kind: 'segment', index: 3}, 'back'],
  ['moveBuilderOrder', {kind: 'polygon', index: 0}, 'front'], ['moveBuilderOrder', {kind: 'polygon', index: 2}, 'up'], ['moveBuilderOrder', {kind: 'segment'}, 'down', {branch: true}],
  ['moveBuilderOrder', {kind: 'segment'}, 'sideways'], ['moveBuilderOrder', {kind: 'polygon', index: 9}, 'up'], ['moveBuilderOrder', {kind: 'blob'}, 'up'],
  ['moveBuilderOrder', {kind: 'segment', index: 0}, 'down'],
  ['setBuilderOrder', {kind: 'segment', index: 2}, 3], ['setBuilderOrder', {kind: 'polygon', index: 1}, 1, {branch: false}], ['setBuilderOrder', {kind: 'segment', index: 1}, 2, {branch: true}],
  ['setBuilderOrder', {kind: 'segment', index: 2}, 99], ['setBuilderOrder', {kind: 'segment', index: 2}, 'x'], ['setBuilderOrder', {kind: 'segment', index: 1}, 2, {branch: true}],
  ['@select', 1, 4], ['orderSelection', 1], ['orderSelection', 'back'], ['orderSelection', -1],
  ['undo'], ['undo'], ['undo'], ['redo'], ['undo'], ['undo'],
];
scenario('builder-order-sheet', app, orderSteps, 'builder.document.json');
scenario('builder-order-native', {}, orderSteps, 'builder.document.json');
// An enabled IK controller refuses a relationship that would derive its joint.
scenario('rig-behavior-ik-sheet', app, [
  ['@select', 1, 3], ['setAngleLock', 'world'], ['setRigBehavior', {weighted: {origin: 3, anchors: [{joint: 2, weight: 1}]}}], ['bindStretchParts', 1],
  ['@select', 1, 0], ['setRigBehavior', {stretch: {}}], ['@select', 1, 3], ['bindStretchParts', 1], ['undo'], ['undo'], ['redo'],
], 'startup.document.json');
