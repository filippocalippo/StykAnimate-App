import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
// Builds the first command-replay scenarios (engine/tests/edit/) with the editor's own fixture kit.
//   node engine/tools/edit-scenarios.mjs && node engine/tools/edit-replay.mjs --all
import {documentOf, limb, open, joint, nextKey, prune, Editor} from './fixture-kit.mjs';
import {createVfxClip} from '../../src/vfx-clips.mjs';
import {createVfx} from '../../src/vfx.mjs';
import {createCameraMotion} from '../../src/camera-motion.mjs';
await import('./edit-scenarios-movieclips-joins.mjs');
await import('./edit-scenarios-movieclips-presence.mjs');
await import('./edit-scenarios-movieclips-membership.mjs');
await import('./edit-scenarios-movieclips-timed.mjs');
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
// A native-timeline document with two limbs (one joined to the other) over two keyframes.
const doc = documentOf([limb(true), limb()], i => [250 + i * 150, 160]);
writeFileSync(`${out}/two-limbs.document.json`, JSON.stringify(doc) + '\n');
// A chain of three figures (3 joined to 2's shin, 2 joined to 1's foot) over two keyframes.
const chain = open(documentOf([limb(true), limb(), limb()], i => [200 + i * 140, 170]));
chain.select(2); chain.joinTo(1, 33); chain.select(3); chain.joinTo(2, 22);
nextKey(chain, 6); chain.select(1); chain.moveSelection(40, 0);
writeFileSync(`${out}/joined-chain.document.json`, JSON.stringify(prune(chain.report), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
const scenario = (name, editor, steps, document = 'two-limbs.document.json', observeFigureClipboardPastes = false) => writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps, ...(observeFigureClipboardPastes ? {observeFigureClipboardPastes: true} : {})}, null, 1) + '\n');
scenario('move-native', {}, [
  ['@select', 1, -1], ['moveSelection', 30, -12], ['moveSelection', -5, 4], ['undo'], ['redo'],
  ['@select', 2, -1], ['beginDrag', 'Move figures'], ['moveSelection', 10, 10], ['moveSelection', 2, 0], ['commitDrag'], ['undo'],
]);
scenario('rotate-native', {}, [
  ['@select', 1, -1], ['rotateSelection', 0.4], ['rotateSelection', -0.1], ['undo'], ['undo'], ['redo'],
]);
scenario('pose-native', {}, [
  ['@select', 1, 1], ['poseJoint', 330, 220], ['@select', 1, 2], ['poseJoint', 360, 260, {stretch: true}], ['undo'], ['redo'],
]);
scenario('move-sheet', {layerTimeline: true, propertyChannels: true}, [
  ['@select', 1, -1], ['moveSelection', 20, 5], ['@seek', 6], ['moveSelection', 40, -10], ['@seek', 3], ['undo'], ['undo'], ['redo'],
]);
scenario('move-joined', {}, [
  ['@seek', 0], ['@select', 3, -1], ['moveSelection', 15, 5], ['undo'], ['redo'], ['@select', 2, -1],
  ['moveSelection', 10, 0, {detachExternal: true}], ['undo'], ['@seek', 6], ['@select', 1, -1], ['moveSelection', -20, 8], ['undo'], ['undo'], ['redo'],
], 'joined-chain.document.json');
scenario('drag-cancel', {}, [
  ['@select', 2, -1], ['beginTranslationDrag'], ['moveSelection', 10, 0, {fromStart: true}], ['moveSelection', 25, -5, {fromStart: true}], ['cancelDrag'],
  ['beginDrag', 'Pose figure'], ['moveSelection', 0, 0], ['commitDrag'], ['beginDrag', 'Pose figure', {scope: 'translation'}], ['moveSelection', 4, 4], ['@seek', 6], ['undo'],
  ['@select', 3, -1], ['beginDrag'], ['moveSelection', 5, 5], ['undo'], ['redo'],
], 'joined-chain.document.json');
scenario('selection-native', {}, [
  ['@select', 99, -1], ['moveSelection', 5, 5], ['undo'], ['redo'], ['@select', 1, 2], ['@select', 2, {add: true}], ['moveSelection', 3, 3],
  ['@select', 1, {toggle: true}], ['selectMany', [2, 1, 7]], ['moveSelection', -3, 1], ['@seek', -4], ['@seek', 100], ['@seek', 2.5], ['moveSelection', 1, 1],
  ['moveSelection', null, 1], ['undo'], ['undo'], ['undo'], ['undo'],
]);
scenario('transform-native', {}, [
  ['@select', 1, -1], ['scaleSelection', 1.5], ['mirrorSelection', 'vertical'], ['mirrorSelection', 'horizontal', {center: {x: 300, y: 200}}],
  ['rotateFigure', 0.3], ['centerFigure'], ['resetPose'], ['selectMany', [1, 2]], ['rotateSelection', 0.2], ['scaleSelected', 0.5],
  ['scaleSelection', 1.25, {selectedOnly: true}], ['rotateFigure', -0.2], ['centerFigure'], ['scaleSelection', -1], ['mirrorSelection', 'diagonal'],
  ['undo'], ['undo'], ['undo'], ['redo'], ['@select', 1, 1], ['mirrorSelection'],
]);
scenario('transform-joined', {}, [
  ['@seek', 3], ['@select', 2, -1], ['rotateSelection', 0.5], ['selectMany', [1, 3]], ['scaleSelection', 2], ['mirrorSelection', 'horizontal'],
  ['@select', 3, -1], ['rotateFigure', 0.7], ['scaleSelection', 0.5], ['centerFigure'], ['@seek', 6], ['@select', 2, -1], ['resetPose'],
  ['beginDrag', 'Pose figure'], ['rotateSelection', 0.1], ['rotateSelection', 0.1], ['cancelDrag'], ['undo'], ['undo'], ['redo'],
], 'joined-chain.document.json');
scenario('pose-joints', {}, [
  ['@select', 1, 0], ['poseJoint', 300, 260], ['rotateJoint', 0.3], ['rotateJoint', -0.1, {isolate: true}], ['@select', 1, 1],
  ['bendJoint', 320, 250], ['bendJoint', 330, 240, {stretch: true}], ['poseJoint', 340, 250, {stretch: true, snap: false}],
  ['beginDrag', 'Pose figure'], ['poseJoint', 330, 270], ['poseJoint', 320, 280, {stretch: true}], ['poseJoint', 318, 279, {stretch: true}], ['commitDrag'],
  ['@select', 1, 1], ['poseJoint', 300, 300, {stretch: true}], ['poseJoint', 305, 300, {stretch: true, snapTolerance: 40}], ['bendJoint', 310, 300, {snapTolerance: 50}],
  ['poseJoint', 1, 2, {snapTolerance: -1}], ['@select', 1, -1], ['poseJoint', 300, 300], ['bendJoint', 300, 300], ['rotateJoint', 1],
  ['@select', 2, 2], ['bendJoint', 420, 260], ['poseJoint', 440, 250], ['undo'], ['undo'], ['undo'], ['redo'],
]);
scenario('pose-joined', {}, [
  ['@select', 1, 2], ['rotateJoint', 0.4], ['poseJoint', 250, 300], ['rotateJoint', 0.2, {isolate: true}], ['@select', 2, 1], ['poseJoint', 300, 380],
  ['bendJoint', 290, 390, {stretch: true}], ['@seek', 3], ['@select', 1, 1], ['poseJoint', 230, 310], ['@select', 3, 0], ['poseJoint', 260, 420, {stretch: true}],
  ['undo'], ['undo'], ['undo'], ['redo'], ['@seek', 6], ['@select', 1, 0], ['rotateJoint', -0.5], ['undo'],
], 'joined-chain.document.json');
// Snapping back to the definition: pointers placed from the editor's own geometry, step by step.
{
  const probe = open(structuredClone(doc)), steps = [];
  const run = step => { steps.push(step); const [method, ...args] = step; probe[method === '@select' ? 'select' : method](...args); };
  const shin = () => probe.geometry.objects.get(0).segments[1];
  const along = (length, turn = 0, side = 0) => {
    const s = shin(), a = s.angle + turn;
    return [s.start.x + length * Math.cos(a) - side * Math.sin(a), s.start.y + length * Math.sin(a) + side * Math.cos(a)];
  };
  run(['@select', 1, 1]);
  run(['poseJoint', ...along(120), {stretch: true}]);          // stretched: the next gesture may snap back
  run(['poseJoint', ...along(93), {stretch: true}]);           // 3 px from 90: snaps to the definition
  run(['poseJoint', ...along(120), {stretch: true}]);
  run(['poseJoint', ...along(93), {stretch: true, snap: false}]); // no snapping
  run(['poseJoint', ...along(99), {stretch: true}]);           // 6 px away after the last: within tolerance? recorded either way
  run(['bendJoint', ...along(90, 0.4)]);                        // bent
  run(['bendJoint', ...along(probe.object.lengths?.[1] ?? 90, 0, 2)]); // 2 px from the straight end: snaps to 0
  run(['bendJoint', ...along(90, 0.3)]);
  run(['bendJoint', ...along(140, 0.02, 3), {stretch: true}]);  // stretching bend, near the straight line at the pointer's distance
  run(['beginDrag', 'Pose figure']);
  run(['poseJoint', ...along(130), {stretch: true}]);
  run(['poseJoint', ...along(91.5), {stretch: true, snapTolerance: 2}]);
  run(['commitDrag']);
  run(['undo']); run(['undo']); run(['redo']);
  scenario('pose-snap', {}, steps);
}
// The app's configuration (src/app.mjs): every document has a layer sheet, so gestures draft
// the evaluated frame and commit through the sheet planner.
const app = {layerTimeline: true, propertyChannels: true};
scenario('gestures-sheet', app, [
  ['@select', 1, -1], ['moveSelection', 20, 5], ['@seek', 3], ['moveSelection', 40, -10], ['@seek', 6], ['@select', 3, -1], ['rotateSelection', 0.4],
  ['@select', 2, 1], ['poseJoint', 300, 380], ['rotateJoint', 0.3], ['bendJoint', 310, 370, {stretch: true}],
  ['@seek', 2], ['@select', 1, 0], ['beginDrag', 'Pose figure'], ['poseJoint', 250, 280], ['poseJoint', 245, 285], ['commitDrag'],
  ['beginTranslationDrag'], ['moveSelection', 12, 0, {fromStart: true}], ['cancelDrag'], ['moveSelection', 0, 0],
  ['undo'], ['undo'], ['redo'], ['@seek', 4], ['@select', 2, -1], ['scaleSelection', 1.2], ['mirrorSelection', 'horizontal'], ['rotateFigure', -0.3], ['centerFigure'], ['resetPose'],
  ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
], 'joined-chain.document.json');
scenario('autokey-sheet', {...app, autoKey: true}, [
  ['@seek', 2], ['@select', 1, -1], ['moveSelection', 10, 10], ['@seek', 5], ['@select', 3, 1], ['rotateJoint', 0.5], ['undo'], ['undo'], ['redo'],
], 'joined-chain.document.json');
// Two layers on a layer sheet: figure 3 (joined to 2) on its own layer, the first layer's
// first key held (constant), and a copy of the document with the second layer locked.
{
  const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
  const layered = open(JSON.parse(JSON.stringify(prune(chain.report))), app);
  const second = layered.createLayer('Second');
  layered.assignFiguresToLayer([3], second.id ?? second);
  layered.sheetSetEasing(['layer-1'], 0, 0, {interpolation: 'constant'});
  layered.seek(0); layered.select(1);
  writeFileSync(`${out}/sheet-layers.document.json`, mirror(layered));
  layered.setLayerLocked(layered.layerForUid(3), true);
  writeFileSync(`${out}/sheet-locked.document.json`, mirror(layered));
}
scenario('layers-sheet', app, [
  ['@seek', 3], ['@select', 3, -1], ['rotateSelection', 0.3], ['@select', 1, -1], ['@seek', 4], ['moveSelection', 12, -6],
  ['selectMany', [1, 3]], ['@seek', 5], ['moveSelection', -4, 9], ['scaleSelection', 1.1], ['@select', 3, 1], ['poseJoint', 380, 420],
  ['@select', 2, -1], ['beginDrag', 'Pose figure'], ['rotateSelection', 0.2], ['@seek', 1], ['undo'], ['undo'], ['undo'], ['redo'], ['@seek', 6], ['@select', 3, -1], ['resetPose'],
  ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'],
], 'sheet-layers.document.json');
scenario('locked-sheet', app, [
  ['@seek', 2], ['@select', 3, -1], ['moveSelection', 5, 5], ['@select', 1, -1], ['moveSelection', 5, 5], ['rotateSelection', 0.2], ['undo'],
  ['@select', 3, 0], ['beginDrag', 'Pose figure'], ['poseJoint', 400, 400], ['commitDrag'], ['undo'],
], 'sheet-locked.document.json');
// A movieclip on a layer sheet: figure 3 captured as a clip, so the layer's keys replace it
// with the clip's instance. Editing other figures bakes the replacement into the new pose;
// editing the instance re-captures the replacement frame in place.
{
  const clipped = open(JSON.parse(JSON.stringify(prune(chain.report))), app);
  clipped.seek(0); clipped.select(3); clipped.createMovieclip({start: 0, end: 7});
  clipped.seek(0); clipped.select(1);
  writeFileSync(`${out}/sheet-movieclip.document.json`, JSON.stringify(clipped.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  const instance = clipped.evaluatedFrame.objects.find(object => clipped.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id)?._styk?.movieclip).unique_id;
  scenario('movieclip-sheet', app, [
    ['@seek', 3], ['@select', instance, -1], ['moveSelection', 14, 6], ['rotateSelection', 0.3], ['undo'], ['redo'],
    ['@select', 1, -1], ['moveSelection', -8, 4], ['@seek', 5], ['@select', 2, 1], ['rotateJoint', 0.4], ['selectMany', [1, instance]], ['moveSelection', 3, 3],
    ['@seek', 0], ['@select', instance, -1], ['scaleSelection', 1.3], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
  ], 'sheet-movieclip.document.json');
}
// The same with only a loose figure captured: the other figures of the layer stay editable,
// and editing them bakes the key's replacements into the new pose.
{
  const base = open(documentOf([limb(true), limb(), limb()], i => [200 + i * 140, 170]));
  base.select(2); base.joinTo(1, 33); nextKey(base, 6); base.select(1); base.moveSelection(40, 0);
  const clipped = open(JSON.parse(JSON.stringify(prune(base.report))), app);
  clipped.seek(0); clipped.select(3); clipped.createMovieclip({start: 0, end: 7});
  clipped.seek(0); clipped.select(1);
  writeFileSync(`${out}/sheet-movieclip-loose.document.json`, JSON.stringify(clipped.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  const instance = clipped.evaluatedFrame.objects.find(object => clipped.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id)?._styk?.movieclip).unique_id;
  scenario('movieclip-loose-sheet', app, [
    ['@seek', 3], ['@select', 1, -1], ['moveSelection', -8, 4], ['@select', instance, -1], ['moveSelection', 9, 9], ['@seek', 5], ['@select', 2, 1], ['rotateJoint', 0.4],
    ['selectMany', [1, instance]], ['moveSelection', 3, 3], ['@seek', 0], ['@select', instance, -1], ['scaleSelection', 1.3], ['@select', 2, -1], ['rotateSelection', 0.2],
    ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
  ], 'sheet-movieclip-loose.document.json');
  // An ordinary IK chain joined to a movieclip ancestor keeps the existing
  // non-assembled pose path. Pointer inputs come from the actual editor.
  {
    const probe = open(JSON.parse(readFileSync(`${out}/sheet-movieclip-loose.document.json`, 'utf8')), app), steps = [];
    const run = step => { steps.push(step); const [method, ...args] = step; return probe[method === '@select' ? 'select' : method](...args); };
    run(['@select', 2, -1]); run(['joinTo', instance, 1]);
    const handle = probe.figure.segments.findIndex(segment => segment.segment_id === 22);
    run(['@select', 2, handle]); run(['setNodeIK', {enabled: true, pinned: false, chainLength: 2}]);
    const tip = probe.geometry.objects.get(probe.selectedSlot).segments[handle].end;
    run(['beginDrag', 'Pose figure']);
    run(['poseJoint', tip.x + 13.25, tip.y - 8.125, {snap: false}]);
    run(['poseJoint', tip.x + 18.5, tip.y - 3.75, {snap: false}]);
    run(['commitDrag']); run(['undo']); run(['redo']);
    const next = probe.geometry.objects.get(probe.selectedSlot).segments[handle].end;
    run(['beginDrag', 'Pose figure']);
    run(['poseJoint', next.x - 7.125, next.y + 11.25, {snap: false}]); run(['cancelDrag']);
    scenario('ik-movieclip-parent-sheet', app, steps, 'sheet-movieclip-loose.document.json');
  }
}
// Keys and frames of the layer timeline, on the two-layer sheet and on the sheet with a clip.
scenario('keys-sheet', app, [
  ['sheetInsertKey', ['layer-1'], 3], ['sheetInsertKey', ['layer-2'], 2, {blank: true}], ['@seek', 5], ['sheetInsertKey'],
  ['sheetSetEasing', ['layer-1'], 0, 3, {interpolation: 'bezier', bezier: [0.2, 0, 0.8, 1]}], ['sheetSetEasing', ['layer-2'], 0, 6, {interpolation: 'hold'}],
  ['sheetSetEasing', ['layer-1'], 0, 1, {interpolation: 'wobble'}], ['sheetInsertKey', ['layer-9'], 1], ['sheetClearKeys', ['layer-1'], 3, 3], ['undo'], ['undo'], ['redo'],
  ['@select', 1, -1], ['moveSelection', 6, 6], ['sheetInsertKey', ['layer-1', 'layer-2'], 9], ['sheetInsertKey', ['scene'], 4], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'],
], 'sheet-layers.document.json');
scenario('frames-sheet', app, [
  ['@seek', 2], ['sheetDuplicateFrameAfter'], ['sheetInsertFrames', ['layer-1', 'layer-2'], 2, 2], ['sheetRemoveFrames', ['layer-2'], 1, 2], ['sheetClearFrames', ['layer-1'], 4, 5],
  ['sheetSetDuration', 3], ['@seek', 1], ['sheetSetDuration', 1, 'layer-2'], ['sheetAppendFrame'], ['sheetAppendFrame', {duration: 3}],
  ['sheetInsertFrames', ['scene', 'camera', 'layer-1', 'layer-2'], 0, 1], ['sheetRemoveFrames', ['layer-1'], 5, 2], ['sheetInsertFrames', ['layer-1'], 1.5], ['sheetSetDuration', 0],
  ['sheetRemoveFrames', ['scene', 'camera', 'layer-1', 'layer-2'], 0, 3], ['@select', 1, -1], ['moveSelection', 4, 4],
  ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'], ['redo'],
], 'sheet-layers.document.json');
scenario('frames-movieclip-sheet', app, [
  ['@seek', 2], ['sheetInsertFrames', ['scene', 'camera', 'layer-1'], 1, 2], ['sheetDuplicateFrameAfter'], ['sheetRemoveFrames', ['layer-1'], 0, 1], ['sheetInsertKey', ['layer-1'], 4],
  ['sheetAppendFrame', {duration: 2}], ['sheetClearFrames', ['layer-1'], 2, 3], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
], 'sheet-movieclip-loose.document.json');
// The same document with the clip's instance on the document's clock (a span and a restart):
// written by hand, as files from before the presence clock have it. Inserting and removing
// frames retimes the span.
{
  const timed = JSON.parse(readFileSync(`${out}/sheet-movieclip-loose.document.json`, 'utf8'));
  for (const frame of Object.values(timed._styk.frameSources)) for (const object of frame.objects)
    if (object._stykMovieclip) object._stykMovieclip = {start: 1, end: 6, offset: 0, speed: 1, mode: 'loop', restarts: [{tick: 3, offset: 0}]};
  writeFileSync(`${out}/sheet-movieclip-timed.document.json`, JSON.stringify(timed) + '\n');
  scenario('frames-timed-clip-sheet', app, [
    ['@seek', 2], ['sheetInsertFrames', ['scene', 'camera', 'layer-1'], 1, 2], ['sheetDuplicateFrameAfter'], ['sheetRemoveFrames', ['layer-1'], 0, 1], ['sheetInsertKey', ['layer-1'], 4],
    ['sheetAppendFrame', {duration: 2}], ['sheetInsertFrames', ['scene', 'camera', 'layer-1'], 0, 1], ['sheetInsertKey', ['layer-1'], 14], ['sheetClearFrames', ['layer-1'], 2, 3],
    ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'],
  ], 'sheet-movieclip-timed.document.json');  // Its frames moved and copied along the timeline: the span and restarts move with them
  // (never before the first frame), the presence clip's frames as they are.
  scenario('move-frames-clip-sheet', app, [
    ['sheetMoveFrames', ['layer-1'], 0, 0, 2], ['sheetMoveFrames', ['layer-1'], 6, 6, 3, {copy: true}], ['sheetMoveFrames', ['layer-1'], 2, 2, -2], ['@seek', 9], ['@select', 4, -1],
    ['sheetMoveFrames', ['layer-1'], 6, 9, 1], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-movieclip-timed.document.json');
  // A clip on the presence clock copied and pasted (on its own layer it keeps its identity,
  // elsewhere it takes a new one that carries on from where it was copied), moved to another
  // layer (the source keeps where it was) and copied back with those continuations; history.
  scenario('clipboard-presence-clip-sheet', app, [
    ['createLayer', 'Clips'], ['sheetCopyFrames', ['layer-1'], 4, 8], ['sheetPasteFrames', ['layer-1'], 10], ['sheetPasteFrames', ['layer-2'], 0],
    ['sheetTransferFrames', ['layer-1'], ['layer-2'], 6, 8, 12], ['sheetCopyFrames', ['layer-1'], 5, 9], ['sheetPasteFrames', ['layer-2'], 20],
    ['sheetTransferFrames', ['layer-2'], ['layer-1'], 0, 2, 24, {copy: true}], ['@seek', 13], ['@select', 5, -1],
    ['sheetCopyFrames', ['layer-1'], 6, 7], ['sheetPasteFrames', ['layer-2'], 40], ['sheetCopyFrames', ['layer-1'], 24, 26], ['sheetPasteFrames', ['layer-2'], 50], ['sheetPasteFrames', ['layer-1'], 30], ['sheetCopyFrames', ['layer-1'], 31, 33], ['sheetPasteFrames', ['layer-2'], 60],
    ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-movieclip.document.json');
  // Property edits on keys whose movieclip frames are replaced: the key keeps its
  // replacements, its pose written from the frame without them.
  scenario('property-clip-patches-sheet', app, [
    ['@select', 4, -1], ['addAnimationKeys', [{target: {kind: 'figure', uid: 4}, property: 'opacity', tick: 0, value: 0.5}]],
    ['addAnimationKeys', [{target: {kind: 'figure', uid: 1}, property: 'scale', tick: 0, value: 1.3}]], ['@seek', 3], ['beginAnimationEdit', {kind: 'figure', uid: 4}, 'scale'],
    ['previewAnimationEdit', 1.4], ['commitAnimationEdit'], ['addAnimationKeys', [{target: {kind: 'figure', uid: 4}, property: 'rotation', tick: 6, value: 0.3}]],
    ['undo'], ['undo'], ['redo'],
  ], 'sheet-movieclip.document.json');
  // Movieclip instances copied and pasted: beside the one on show (a new identity carrying on
  // from where the copy was, the definition shared), where it was deleted (it keeps its
  // identity and starts again), as a unique copy (a new definition), duplicated; history.
  scenario('figure-clipboard-clip-sheet', app, [
    ['@seek', 2], ['@select', 4, -1], ['copySelection'], ['pasteSelection'], ['@seek', 6], ['@select', 4, -1], ['deleteSelection'], ['pasteSelection'],
    ['pasteSelection', {pasteMode: 'unique'}], ['@select', 4, -1], ['duplicateSelection'], ['pasteSelection', {newIdentities: true, offset: 10}],
    ['undo'], ['undo'], ['undo'], ['redo'],
    // A delete between keys restores the replacements after it; a paste where the clip was
    // deleted lands on its own layer while another is active.
    ['@seek', 2], ['@select', 4, -1], ['deleteSelection'], ['createLayer', 'Other'], ['pasteSelection'], ['pasteSelection'], ['undo'], ['undo'], ['undo'], ['undo'],
    // A clip played once is gone from view after its end but still in its cell: a paste there
    // takes a new identity.
    ['sheetInsertFrames', ['scene', 'camera', 'layer-1'], 6, 8], ['@seek', 2], ['@select', 4, -1], ['setMovieclipPlayback', {mode: 'once'}], ['copySelection'],
    ['@seek', 12], ['pasteSelection'],
    // A clip pasted with another figure onto a held cell keys the playhead.
    ['sheetSetEasing', ['layer-1'], 0, 0, {interpolation: 'constant'}], ['@seek', 1], ['addFigure', 1], ['@select', 4, -1], ['selectMany', [4, 10]], ['copySelection'], ['@seek', 3], ['pasteSelection'],
  ], 'sheet-movieclip.document.json');
  // The figure clipboard counter is read only after the original paste returns.
  // Explicit zero suppresses its increment; a cut's implicit zero offset does not.
  // Duplicate temporarily copies/pastes, then restores the saved clipboard object.
  scenario('figure-clipboard-pastes-sheet', app, [
    ['@select', 4, -1], ['pasteSelection'], ['copySelection'], ['pasteSelection'], ['pasteSelection'], ['pasteSelection', {offset: 0}],
    ['pasteSelection', {pasteMode: 'bogus'}], ['pasteSelection', {pasteDepth: 'x'}], ['pasteSelection', {offset: 'x'}],
    ['@select', 4, -1], ['duplicateSelection'], ['duplicateSelection', {offset: 0}], ['selectMany', []], ['copySelection'], ['pasteSelection'],
    ['@select', 4, -1], ['cutSelection'], ['pasteSelection'], ['pasteSelection', {offset: 0}], ['undo'], ['redo'], ['selectMany', []], ['duplicateSelection'],
    ['@seek', 2], ['@select', 4, -1], ['copySelection'], ['pasteSelection'], ['@seek', 6], ['@select', 4, -1], ['deleteSelection'], ['pasteSelection'], ['undo'], ['redo'],
  ], 'sheet-movieclip.document.json', true);
  // Range operations on a movieclip instance on a layer sheet: ordered, flipped, turned,
  // duplicated (the copy restarts on the presence clock), deleted at the playhead and across
  // keys (replacements by nothing); history.
  scenario('range-clip-sheet', app, [
    ['@seek', 2], ['@select', 4, -1], ['setMovieclipPlayback', {offset: 3, speed: 2}], ['duplicateInFrames', [0]], ['undo'], ['undo'], ['@select', 4, -1],
    ['orderFiguresInFrames', 1, [0]], ['mirrorFiguresInFrames', 'horizontal', [0]], ['rotateFiguresInFrames', 0.3, [0]], ['duplicateInFrames', [0]], ['@select', 4, -1], ['deleteFiguresInFrames', [0]], ['undo'], ['@seek', 6], ['@select', 4, -1], ['deleteFiguresInFrames', [0, 1]],
    ['undo'], ['undo'], ['redo'],
  ], 'sheet-movieclip.document.json');
  // A clip on the presence clock given new playback on every frame: each key of its layer and
  // each replacement holding it; refusals (placement and restarts belong to the document's
  // clock); after its frames were copied elsewhere, the continuations too; history.
  scenario('clip-playback-all-sheet', app, [
    ['@select', 4, -1], ['createLayer', 'Clips'], ['sheetTransferFrames', ['layer-1'], ['layer-2'], 6, 6, 3], ['@seek', 3], ['@select', 5, -1],
    ['setMovieclipPlayback', {speed: 3}, {allFrames: true}], ['setMovieclipPlayback', {speed: 3}, {allFrames: true}], ['undo'], ['undo'], ['undo'],
    ['@seek', 0], ['@select', 4, -1], ['setMovieclipPlayback', {speed: 2, mode: 'once'}, {allFrames: true}], ['setMovieclipPlayback', {offset: 1}, {allFrames: true}],
    ['setMovieclipPlayback', {start: 3}, {allFrames: true}], ['restartMovieclip'], ['removeMovieclipRestart'], ['setMovieclipPlayback', {speed: 2, mode: 'once'}, {allFrames: true}],
    ['createLayer', 'Clips'], ['sheetTransferFrames', ['layer-1'], ['layer-2'], 6, 6, 3], ['@seek', 0], ['@select', 4, -1], ['setMovieclipPlayback', {mode: 'hold'}, {allFrames: true}],
    ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-movieclip.document.json');
  // Camera motion clips added (each preset, a follow clip following the selected figures to the
  // end, refusals), copied and pasted, duplicated, given a new seed; identities and seeds drawn
  // by the editor (D18); history.
  scenario('camera-motion-add-sheet', app, [
    ['addCameraMotion', 'shake'], ['addCameraMotion', 'impact', {start: 2}], ['addCameraMotion', 'handheld', {duration: 5}], ['addCameraMotion', 'wobble'], ['addCameraMotion', 'pulse', {start: 1, duration: 3}],
    ['addCameraMotion', 'bogus'], ['addCameraMotion', 'follow'], ['@select', 1, -1], ['addCameraMotion', 'follow'], ['addCameraMotion', 'follow', {targets: [{uid: 1, weight: 2}]}],
    ['copyCameraMotion', 'nope'], ['pasteCameraMotion'], ['copyCameraMotion', 'motion-d0d0d0d0-0000-4000-8000-000000000001'], ['@seek', 3], ['pasteCameraMotion'], ['pasteCameraMotion', 5],
    ['duplicateCameraMotion', 'motion-d0d0d0d0-0000-4000-8000-000000000002'], ['duplicateCameraMotion', 'motion-d0d0d0d0-0000-4000-8000-000000000002', 1], ['duplicateCameraMotion', 'nope'],
    ['randomizeCameraMotion', 'motion-d0d0d0d0-0000-4000-8000-000000000003'], ['randomizeCameraMotion', 'nope'], ['setLayerLocked', 'camera', true], ['addCameraMotion', 'shake'], ['setLayerLocked', 'camera', false],
    ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'joined-chain.document.json');
  // A clip with muted ranges pasted and duplicated (the ranges move with it), from a playhead
  // between frames.
  scenario('camera-motion-paste-sheet', app, [
    ['copyCameraMotion', 'motion-00000000-0000-4000-8000-000000000002'], ['@seek', 4.5], ['pasteCameraMotion'], ['duplicateCameraMotion', 'motion-00000000-0000-4000-8000-000000000002', 30],
    ['undo'], ['redo'],
  ], 'camera-motion.document.json');
  // Effects in a figure's, a segment's and the scene's stacks: added (to several targets,
  // refusals by kind and target), duplicated, moved, reordered, reset, removed and pasted
  // (replacing the same effect, a new identity for another kind of the same identity, the
  // scope set); new identities drawn by the editor (D18); history.
  {
    const figure = uid => ({kind: 'figure', uid}), segment = (uid, handleId) => ({kind: 'segment', uid, handleId}), scene = {kind: 'scene'};
    const [blur, glow, grade] = [1, 2, 3].map(n => `fx-0000000000004000800000000000000${n}`);
    scenario('vfx-stack-sheet', app, [
      ['@select', 1, -1], ['addVfx', figure(1), 'glow'], ['addVfx', [figure(1), segment(1, 22)], 'tint'], ['addVfx', scene, 'vignette'], ['addVfx', figure(1), 'vignette'],
      ['addVfx', figure(1), 'bogus'], ['addVfx', scene, 'outline'], ['addVfx', {kind: 'camera'}, 'glow'], ['duplicateVfx', figure(1), blur], ['duplicateVfx', figure(1), 'fx-none'],
      ['moveVfx', figure(1), blur, 1], ['moveVfx', figure(1), blur, 2], ['reorderVfx', figure(1), blur, 0], ['reorderVfx', figure(1), blur, 9],
      ['setVfxParameter', figure(1), blur, 'radius', 6], ['resetVfx', figure(1), blur], ['resetVfx', figure(1), 'fx-none'], ['removeVfx', figure(1), blur], ['removeVfx', figure(1), 'fx-none'],
      ['pasteVfx', segment(1, 22), [{version: 2, id: blur, type: 'blur', enabled: true, params: {radius: 3}}]],
      ['pasteVfx', scene, [{version: 2, id: grade, type: 'blur', enabled: true, params: {radius: 2}}]], ['pasteVfx', scene, [{version: 2, id: grade, type: 'grade', enabled: false, params: {}}]],
      ['pasteVfx', [figure(1)], [{version: 2, id: glow, type: 'glow', enabled: true, params: {}}], {includeAttached: false}], ['pasteVfx', figure(1), [], {includeAttached: 'x'}],
      ['pasteVfx', figure(1), [{version: 2, id: 'fx-x', type: 'vignette', enabled: true, params: {}}]],
      ['@seek', 3], ['addVfx', figure(1), 'pixelate'], ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'property-vfx.document.json');
  }
  scenario('move-frames-presence-clip-sheet', app, [
    ['sheetMoveFrames', ['layer-1'], 0, 0, 2], ['sheetMoveFrames', ['layer-1'], 6, 6, 3, {copy: true}], ['undo'], ['redo'],
  ], 'sheet-movieclip.document.json');
}
// Commands that draft the whole frame on a sheet: joins, duplicates and deletions.
scenario('figures-sheet', app, [
  ['@seek', 2], ['@select', 3, -1], ['unjoinFigure'], ['joinTo', 1, 22], ['joinFigure', null], ['joinTo', 3, 0], ['joinTo', 2, 99], ['joinTo', 2, 11],
  ['@select', 2, -1], ['joinTo', 3, 0], ['duplicateFigure'], ['moveSelection', 10, -30], ['duplicateFigure'], ['undo'], ['@seek', 4], ['@select', 1, -1], ['rotateSelection', 0.2],
  ['@select', 2, -1], ['deleteSelection'], ['undo'], ['@select', 1, -1], ['deleteFigure'], ['selectMany', [2, 3]], ['deleteSelection'], ['deleteSelection'],
  ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'], ['redo'], ['redo'],
], 'joined-chain.document.json');
scenario('figures-layers-sheet', app, [
  ['@seek', 3], ['@select', 3, -1], ['duplicateFigure'], ['@select', 3, -1], ['unjoinFigure'], ['@select', 1, -1], ['duplicateFigure'], ['joinTo', 3, 11],
  ['selectMany', [1, 3]], ['deleteSelection'], ['undo'], ['undo'], ['@seek', 5], ['@select', 2, 1], ['rotateJoint', 0.3], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
], 'sheet-layers.document.json');
// The document the app starts with: one figure with four enabled, unpinned IK controllers
// (hands and feet). Posing an elbow, transforms, a duplicate (its targets move with it),
// timeline keys; posing a hand moves its controller's target and solves the limb, which
// styk-edit does not run yet, so the scenario ends there.
{
  const startup = new Editor({demo: false, ...app}).newDocument();
  writeFileSync(`${out}/startup.document.json`, JSON.stringify(startup.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  scenario('startup-sheet', app, [
    ['@select', 1, 2], ['poseJoint', 530, 220], ['rotateJoint', 0.2], ['bendJoint', 540, 230, {stretch: true}], ['@select', 1, 6], ['poseJoint', 520, 380],
    ['@select', 1, -1], ['moveSelection', 10, 5], ['rotateSelection', 0.1], ['scaleSelection', 1.1], ['mirrorSelection', 'horizontal'], ['rotateFigure', -0.2],
    ['duplicateFigure'], ['moveSelection', 30, 0], ['undo'], ['undo'], ['sheetInsertKey', ['layer-1'], 4], ['@seek', 4], ['@select', 1, 2], ['poseJoint', 500, 210], ['resetPose'],
    ['undo'], ['undo'], ['undo'], ['redo'], ['@seek', 0], ['@select', 1, 3], ['poseJoint', 520, 300],
  ], 'startup.document.json');
  // Unpinned controllers: dragging the end of a limb solves it (poseIKTarget). A leg whose
  // foot branches follow the target (static artwork, a construction pivot, a polygon), on
  // Both; a three-bone chain on one side that stretches out of reach.
  {
    const fixed = {is_static: true, aux_code: 1};
    const leg = [[11, 0, 90, .8], [12, 11, 20, .3, fixed], [22, 11, 90, 2], [23, 22, .00027, -1.6, fixed], [24, 23, 18, 1.1, fixed],
      [33, 23, 35, 0], [34, 33, 10, .2, fixed], [35, 23, 25, 1.5, fixed], [41, 22, 16, 1.1, fixed]];
    const document = documentOf([leg, [[1, 0, 60, .3], [2, 1, 55, .9], [3, 2, 50, 1.4], [4, 3, 20, 0]]], i => [220 + i * 260, 140]);
    document.figure_types[0].polyfills = [{polyfill_id: 1, segment_ids: [22, 35, 34, 33], color_rgb: [10, 35, 65], alpha_raw: 0, z_order: 0}];
    const e = open(document);
    joint(e, 22, 1); e.setNodeIK({enabled: true, pinned: false});
    joint(e, 3, 2); e.setNodeIK({enabled: true, pinned: false, chainLength: 3, bendDirection: 1, allowStretch: true});
    writeFileSync(`${out}/ik-unpinned.document.json`, JSON.stringify(prune(e.report), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  }
  scenario('ik-unpinned-sheet', app, [
    ['@select', 1, 2], ['poseJoint', 260, 270], ['beginDrag', 'Pose figure'], ['poseJoint', 280, 290], ['poseJoint', 300, 300], ['poseJoint', 330, 320], ['commitDrag'],
    ['undo'], ['redo'], ['@select', 2, 2], ['poseJoint', 560, 230], ['poseJoint', 600, 300], ['beginDrag', 'Pose figure'], ['poseJoint', 540, 200], ['poseJoint', 520, 215], ['cancelDrag'],
    ['@seek', 5], ['@select', 1, 2], ['poseJoint', 240, 280], ['poseJoint', 250, 300, {stretch: true}], ['@select', 1, -1], ['moveSelection', 12, -6], ['@select', 2, 2], ['poseJoint', 470, 250],
    ['undo'], ['undo'], ['undo'], ['redo'], ['@seek', 0], ['@select', 1, 5], ['poseJoint', 230, 330],
  ], 'ik-unpinned.document.json');
  // Pinned controllers: the limb is drawn solved. Moving the figure leaves the targets; a
  // pinned end moves its target; posing bakes the solution first; a stretch drag moves the pin.
  scenario('pinned-ik-sheet', app, [
    ['@select', 1, -1], ['@seek', 2], ['sheetInsertKey', ['layer-1'], 3], ['sheetDuplicateFrameAfter'], ['undo'], ['moveSelection', 5, 5],
    ['@select', 1, 3], ['poseJoint', 530, 300], ['@select', 1, 2], ['rotateJoint', 0.3], ['@select', 1, 3], ['poseJoint', 540, 320, {stretch: true}],
    ['@select', 1, 0], ['bendJoint', 480, 250], ['@select', 1, -1], ['rotateSelection', 0.1], ['beginDrag', 'Move figures'], ['moveSelection', 3, 3], ['moveSelection', 3, 3],
    ['commitDrag'], ['undo'], ['undo'], ['redo'], ['@seek', 0], ['@select', 1, 7], ['poseJoint', 500, 420], ['@select', 1, 6], ['rotateJoint', -0.2],
  ], '../../crates/styk-eval/tests/fixtures/ik/startup-pinned.json');
  // A pinned foot whose branches follow the target: turning a follower changes its offset,
  // turning the thigh leaves the target's orientation planted.
  scenario('ik-followers-sheet', app, [
    ['@select', 1, -1], ['moveSelection', 20, -10], ['@select', 1, 2], ['poseJoint', 350, 280], ['@select', 1, 5], ['rotateJoint', 0.3],
    ['@select', 1, 0], ['rotateJoint', -0.2], ['@select', 1, 2], ['poseJoint', 380, 330, {stretch: true}], ['@seek', 4], ['@select', 1, 5],
    ['beginDrag', 'Pose figure'], ['rotateJoint', 0.1], ['rotateJoint', 0.1], ['commitDrag'], ['undo'], ['redo'], ['@select', 1, -1], ['mirrorSelection', 'horizontal'], ['undo'],
  ], '../../crates/styk-eval/tests/fixtures/ik/followers.json');
  // IK across joined figures: the shin's controller drives a thigh of another figure, and
  // the foot and toe joined at its end follow it (joinedFollowers).
  scenario('ik-joined-sheet', app, [
    ['@select', 1, -1], ['moveSelection', 10, 5], ['@select', 2, 0], ['poseJoint', 350, 280], ['@select', 3, 0], ['rotateJoint', 0.3],
    ['@select', 1, 0], ['rotateJoint', -0.2], ['@select', 2, 0], ['poseJoint', 390, 330, {stretch: true}], ['@select', 3, 0],
    ['beginDrag', 'Pose figure'], ['rotateJoint', 0.1], ['rotateJoint', 0.1], ['commitDrag'], ['undo'], ['redo'], ['@select', 1, -1], ['rotateSelection', 0.2], ['undo'],
  ], '../../crates/styk-eval/tests/fixtures/ik/joined.json');
  {
    const e = open(JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/ik/joined.json', import.meta.url), 'utf8')));
    e.select(2, 0); e.setNodeIK({pinned: false});
    writeFileSync(`${out}/ik-joined-unpinned.document.json`, JSON.stringify(prune(e.report), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  }
  // The same assembly with the controller free: dragging the end solves across the figures.
  scenario('ik-joined-unpinned-sheet', app, [
    ['@select', 2, 0], ['poseJoint', 350, 270], ['beginDrag', 'Pose figure'], ['poseJoint', 360, 280], ['poseJoint', 380, 300], ['commitDrag'], ['undo'], ['redo'],
    ['@select', 3, 0], ['rotateJoint', 0.2], ['@select', 1, -1], ['moveSelection', 5, 5], ['@seek', 3], ['@select', 2, 0], ['poseJoint', 330, 300],
  ], 'ik-joined-unpinned.document.json');
  // A foot joined to the shin's end after the shin's controller was set: a pose edit bakes
  // its follower into the controller (joinedFollowers).
  {
    const fixed = {is_static: true, aux_code: 1};
    const document = documentOf([[[11, 0, 90, .8], [12, 11, 20, .3, fixed]], [[22, 0, 90, 2]], [[33, 0, 35, 0], [34, 33, 10, .2, fixed]]]);
    document.keyframes[0].objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 11};
    const e = open(document);
    e.select(2, 0); e.setNodeIK({enabled: true}); e.poseJoint(365, 265);
    e.select(3, -1); e.joinTo(2, 22);
    writeFileSync(`${out}/ik-joined-late.document.json`, JSON.stringify(prune(e.report), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  }
  scenario('ik-joined-late-sheet', app, [
    ['@select', 1, 0], ['rotateJoint', -0.1], ['@select', 3, 0], ['rotateJoint', 0.2], ['@select', 2, 0], ['poseJoint', 340, 290], ['undo'], ['undo'], ['redo'],
  ], 'ik-joined-late.document.json');
  // Stick Nodes curves: a straight segment with a sagitta is drawn as a curve whose bend
  // the editor's geometry reports as 1e-6, which the pose arithmetic then uses.
  {
    const document = documentOf([[[11, 0, 90, .8, {primitive_code: 0, _sticknodes: {kind: 'rounded-segment', sagitta: 12}}],
      [22, 11, 90, 2, {primitive_code: 6, _sticknodes: {kind: 'segment', sagitta: 0}}], [33, 22, 35, 0, {primitive_code: 0}]]]);
    document.keyframes[0].objects[0]._sticknodesShapes = {22: {kind: 'segment', sagitta: -9, reversed: true}, 33: {kind: 'rounded-segment', sagitta: 5}};
    writeFileSync(`${out}/sticknodes.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('sticknodes-sheet', app, [
    ['@select', 1, 0], ['poseJoint', 330, 230], ['rotateJoint', 0.1], ['bendJoint', 340, 220], ['@select', 1, 1], ['poseJoint', 300, 300],
    ['bendJoint', 290, 310, {stretch: true}], ['@select', 1, 2], ['poseJoint', 280, 330, {stretch: true}], ['bendJoint', 270, 335], ['undo'], ['undo'], ['redo'],
  ], 'sticknodes.document.json');
  // Rig controls: a stretch driver and the bones that follow it (posed in its space), an
  // angle-locked bone (it only stretches), and a connector between two joints (it slides
  // and bends along its centerline).
  {
    const e = open(documentOf([[[11, 0, 90, .8], [22, 11, 90, 2], [33, 22, 35, 0], [44, 0, 70, 2.4], [55, 44, 60, 1.6]]]));
    joint(e, 22, 1); e.enableSmartStretch(true);
    joint(e, 44, 1); e.setAngleLock('world');
    e.select(1, 0); e.addConnector(33, 55, {position: .4});
    writeFileSync(`${out}/rig.document.json`, JSON.stringify(prune(e.report), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  }
  scenario('rig-sheet', app, [
    ['@select', 1, 2], ['poseJoint', 300, 330], ['@select', 1, 1], ['poseJoint', 330, 300, {stretch: true}], ['@select', 1, 2], ['poseJoint', 310, 340],
    ['@select', 1, 3], ['poseJoint', 240, 200], ['rotateJoint', 0.3], ['poseJoint', 230, 210, {stretch: true}], ['bendJoint', 228, 205],
    ['@select', 1, 5], ['poseJoint', 280, 260], ['bendJoint', 285, 250], ['setConnectorPosition', 0.7], ['setConnectorPosition', 2],
    ['@select', 1, 4], ['bendJoint', 220, 240], ['@select', 1, -1], ['moveSelection', 10, 5], ['undo'], ['undo'], ['redo'],
  ], 'rig.document.json');
  // Rigs with pinned IK: the solver works through the rig's spaces.
  for (const fixture of ['rig-follow', 'rig-stretch']) scenario(`ik-${fixture}-sheet`, app, [
    ['@select', 1, -1], ['moveSelection', 10, 5], ['rotateSelection', 0.1], ['@select', 1, 1], ['rotateJoint', 0.2], ['bendJoint', 260, 200],
    ['undo'], ['undo'], ['redo'],
  ], `../../crates/styk-eval/tests/fixtures/ik/${fixture}.json`);
  // 3D documents: transforms, timeline keys and history on figures with 3D bones, meshes,
  // surfaces, perspective and part proportions.
  for (const fixture of ['mesh-perspective', 'mesh-sheet', 'surfaces-skin', 'surfaces-perspective', 'mesh-mechanism', 'clip-mesh']) scenario(`spatial-${fixture}-sheet`, app, [
    ['@select', 1, -1], ['moveSelection', 12, -6], ['rotateSelection', 0.15], ['scaleSelection', 1.1], ['mirrorSelection', 'horizontal'], ['rotateFigure', -0.1],
    ['centerFigure'], ['@seek', 2], ['sheetInsertKey', ['layer-1'], 2], ['moveSelection', -5, 5], ['resetPose'], ['undo'], ['undo'], ['undo'], ['redo'],
  ], `../../crates/styk-eval/tests/fixtures/spatial/${fixture}.json`);
  // Turning 3D bones (setSpatialPose, and rotateJoint on a bone) in perspective, and the
  // hinges and slides of a mechanism (setSpatialMotion), one hinge driven by another.
  scenario('spatial-turn-sheet', app, [
    ['@select', 1, 5], ['rotateJoint', 0.2], ['rotateJoint', -0.1, {isolate: true}], ['setSpatialPose', {turn: 0.3}], ['setSpatialPose', {pitch: -0.2, bend: 0.1}],
    ['@select', 1, 8], ['rotateJoint', 0.4], ['setSpatialPose', {bend: 0.5}, {wholeFigure: true}], ['setSpatialPose', {roll: 1}],
    ['@select', 1, 5], ['setSpatialPose', {turn: 0.1}, {wholeFigure: true}], ['setSpatialPose', {turn: 0.1}], ['undo'], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/spatial/mesh-perspective.json');
  scenario('spatial-mechanism-sheet', app, [
    ['@select', 1, 8], ['rotateJoint', 0.3], ['setSpatialMotion', 0.9], ['setSpatialMotion', 0.25, {fraction: true}], ['@select', 1, 11], ['setSpatialMotion', 10],
    ['setSpatialMotion', 1, {fraction: true}], ['rotateJoint', 0.2], ['setSpatialMotion', null], ['@select', 1, 14], ['rotateJoint', 0.5], ['@select', 1, 5],
    ['setSpatialPose', {turn: 0.2, pitch: 0.1}], ['@select', 1, 2], ['setSpatialMotion', 0.5], ['undo'], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/spatial/mesh-mechanism.json');
  // Dragging 3D bones on the canvas: turned flat on screen, swung in depth (the depth key
  // pressed mid-drag), stretched, twisted; and a mechanism's hinges and slide moved along
  // their tracks.
  scenario('spatial-drag-sheet', app, [
    ['@select', 1, 8], ['beginDrag', 'Pose figure'], ['poseJoint', 380, 230], ['poseJoint', 390, 250], ['poseJoint', 400, 270], ['commitDrag'],
    ['beginDrag', 'Pose figure'], ['poseJoint', 380, 230, {depth: true}], ['poseJoint', 360, 240, {depth: true, alternate: true}], ['poseJoint', 350, 260], ['commitDrag'],
    ['beginDrag', 'Pose figure'], ['poseJoint', 390, 240, {stretch: true}], ['poseJoint', 395, 250, {stretch: true}], ['commitDrag'],
    ['@select', 1, 5], ['beginDrag', 'Pose figure'], ['bendJoint', 300, 200], ['bendJoint', 340, 200, {pixel: 2}], ['commitDrag'], ['bendJoint', 320, 210],
    ['poseJoint', 300, 250, {depth: true, pixel: 2, anchor: {x: 310, y: 240}}],
    // Inside the bone's projected reach the bone leaves the view plane, on the gesture's side
    // or, with the alternate key, the other.
    ['@select', 1, 8], ['beginDrag', 'Pose figure'], ['poseJoint', 380, 230, {depth: true, pixel: 3}], ['poseJoint', 340, 200, {depth: true, pixel: 3}],
    ['poseJoint', 420, 260, {depth: true, alternate: true, pixel: 3}], ['poseJoint', 360, 280, {depth: true, alternate: true, pixel: 3}], ['commitDrag'],
    ['undo'], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/spatial/mesh-perspective.json');
  // The slide's handle as the editor draws it: the drag starts there.
  const mechanism = JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/spatial/mesh-mechanism.json', import.meta.url), 'utf8'));
  const probe = open(structuredClone(mechanism), app); probe.select(1, 11);
  const slide = probe.geometry.objects.get(0).joints.get(12), at = (dx, dy) => [slide.x + dx, slide.y + dy];
  scenario('spatial-mechanism-drag-sheet', app, [
    ['@select', 1, 8], ['beginDrag', 'Pose figure'], ['poseJoint', 340, 200], ['poseJoint', 360, 220], ['commitDrag'],
    ['@select', 1, 11], ['beginDrag', 'Pose figure'], ['poseJoint', ...at(1, 1), {anchor: {x: slide.x, y: slide.y}}], ['poseJoint', ...at(6, 3)], ['poseJoint', ...at(12, -2)], ['commitDrag'],
    ['beginDrag', 'Pose figure'], ['poseJoint', ...at(400, 0)], ['commitDrag'],
    ['@select', 1, 14], ['poseJoint', 350, 250], ['@select', 1, 5], ['beginDrag', 'Pose figure'], ['poseJoint', 330, 160], ['commitDrag'], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/spatial/mesh-mechanism.json');
  // A planted 3D leg (a spatial IK target): moves, keys and duplicates; turning the body;
  // turning the thigh releases the leg; posing the foot plants its new orientation.
  for (const fixture of ['spatial', 'spatial-side', 'spatial-mirrored']) scenario(`ik-${fixture}-sheet`, app, [
    ['@select', 1, -1], ['moveSelection', 10, 5], ['rotateSelection', 0.1], ['@seek', 2], ['sheetInsertKey', ['layer-1'], 2], ['duplicateFigure'], ['undo'],
    ['@select', 1, 3], ['rotateJoint', 0.2], ['@select', 1, 12], ['beginDrag', 'Pose figure'], ['poseJoint', 330, 300], ['poseJoint', 340, 310], ['commitDrag'],
    ['rotateJoint', 0.3], ['rotateJoint', 0.25, {isolate: true}], ['@select', 1, 6], ['rotateJoint', 0.15], ['undo'], ['undo'], ['redo'],
  ], `../../crates/styk-eval/tests/fixtures/ik/${fixture}.json`);
  // Posing 3D IK targets: a planted 3D foot moved (its knee keeping its side on screen),
  // pushed in depth then dragged on from where the push left it, its swivel, pole and depth
  // set; a leg bent to one side; and a free 3D leg posed by its foot.
  {
    const legs = name => JSON.parse(readFileSync(new URL(`../crates/styk-eval/tests/fixtures/ik/${name}.json`, import.meta.url), 'utf8'));
    const foot = name => { const e = open(legs(name), app); e.select(1, 9); const p = e.geometry.objects.get(0).joints.get(10); return (dx, dy) => [p.x + dx, p.y + dy]; };
    for (const name of ['spatial', 'spatial-side']) {
      const at = foot(name);
      scenario(`ik-${name}-target-sheet`, app, [
        ['@select', 1, 9], ['beginDrag', 'Pose figure'], ['poseJoint', ...at(8, -4)], ['poseJoint', ...at(16, -10)], ['poseJoint', ...at(-12, 6)], ['commitDrag'],
        ['beginDrag', 'Pose figure'], ['poseJoint', ...at(0, 0), {depth: true, pixel: 2}], ['poseJoint', ...at(0, 30), {depth: true, pixel: 2}], ['poseJoint', ...at(5, 30)], ['poseJoint', ...at(10, 25)], ['commitDrag'],
        ['setSpatialIKTarget', {swivel: 0.3}], ['setSpatialIKTarget', {pole: [0, 0, 1]}], ['setSpatialIKTarget', {depth: 5}], ['setSpatialIKTarget', {bad: 1}], ['setSpatialIKTarget', {pole: [1, 1, 0]}],
        ['undo'], ['undo'], ['redo'],
      ], `../../crates/styk-eval/tests/fixtures/ik/${name}.json`);
    }
    const free = open(legs('spatial'));
    free.select(1, 9); free.setNodeIK({pinned: false});
    writeFileSync(`${out}/ik-spatial-free.document.json`, JSON.stringify(prune(free.report), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
    const at = foot('spatial');
    scenario('ik-spatial-free-sheet', app, [
      ['@select', 1, 9], ['beginDrag', 'Pose figure'], ['poseJoint', ...at(8, -4)], ['poseJoint', ...at(16, -10)], ['poseJoint', ...at(-12, 6)], ['commitDrag'],
      ['poseJoint', ...at(4, 4)], ['setSpatialIKTarget', {swivel: -0.2}], ['setSpatialIKTarget', {depth: 3}], ['undo'], ['redo'],
    ], 'ik-spatial-free.document.json');
  }
  // Steering planted 3D legs: dragging the knee swings the leg's bend plane (its pole),
  // twisting the thigh its swivel, twisting the ankle turns the foot; the whole figure turns
  // with its targets, and the rest pose releases them.
  for (const name of ['spatial', 'spatial-side', 'spatial-mirrored']) {
    const fixture = `../../crates/styk-eval/tests/fixtures/ik/${name}.json`;
    const e = open(JSON.parse(readFileSync(new URL(`../crates/styk-eval/tests/fixtures/ik/${name}.json`, import.meta.url), 'utf8')), app);
    e.select(1, 6);
    const k = e.geometry.objects.get(0).joints.get(7), knee = (dx, dy) => [k.x + dx, k.y + dy];
    scenario(`ik-${name}-steer-sheet`, app, [
      ['@select', 1, 6], ['beginDrag', 'Pose figure'], ['poseJoint', ...knee(10, 4)], ['poseJoint', ...knee(25, -6)], ['commitDrag'], ['poseJoint', ...knee(-15, 0)],
      ['beginDrag', 'Pose figure'], ['bendJoint', ...knee(0, 0)], ['bendJoint', ...knee(40, 0)], ['bendJoint', ...knee(90, 5), {pixel: 2}], ['commitDrag'],
      ['@select', 1, 9], ['beginDrag', 'Pose figure'], ['bendJoint', ...knee(0, 0)], ['bendJoint', ...knee(-50, 0)], ['bendJoint', ...knee(-80, 10)], ['commitDrag'],
      ['@select', 1, 3], ['setSpatialPose', {turn: 0.4}, {wholeFigure: true}], ['setSpatialPose', {pitch: -0.2, bend: 0.1}, {wholeFigure: true}],
      ['resetSpatialPose', true], ['undo'], ['@select', 1, 6], ['resetSpatialPose'], ['resetSpatialPose', true], ['undo'], ['undo'], ['redo'],
    ], fixture);
  }
  // Resetting 3D poses: one bone, a slide and a hinge to their rest travel, the whole rig
  // (the slide's range starting past its rest length).
  {
    const shifted = structuredClone(mechanism);
    shifted.figure_types[0].segments[11]._stykRig.spatial.motion.min = 5;
    writeFileSync(`${out}/spatial-reset.document.json`, JSON.stringify(shifted) + '\n');
  }
  scenario('spatial-reset-sheet', app, [
    ['@select', 1, 11], ['setSpatialMotion', 10], ['resetSpatialPose'], ['@select', 1, 8], ['setSpatialMotion', 0.9], ['resetSpatialPose'],
    ['@select', 1, 5], ['setSpatialPose', {turn: 0.2, pitch: 0.1}], ['resetSpatialPose'], ['setSpatialPose', {turn: -0.3}], ['@select', 1, 11], ['setSpatialMotion', 4],
    ['resetSpatialPose', true], ['undo'], ['undo'], ['redo'],
  ], 'spatial-reset.document.json');
  // Pose choices: a group of 3D bones shown one at a time (or none), and a group of presets
  // over existing channels (as tests/rig-pose-choices.test.mjs builds them), on a figure
  // turned, moved, scaled and mirrored.
  {
    const {construction} = await import('../../src/rig-examples-3d.mjs');
    const {createObject, createFrame, emptyDocument} = await import('../../src/demo.mjs');
    const {compilePoseChoices} = await import('./pose-presets.mjs');
    const eyes = () => {
      const q = construction(); q.add(0, 0, 0, 'Figure rotation');
      for (const label of ['Neutral', 'Focused', 'Closed']) {
        const turn = q.add(0, 0, 0, label + ' turn'), pitch = q.add(0, 0, 0, label + ' tilt');
        const id = q.add(0, 27, 0, label, {rig: {spatial: {parent: 0, origin: [0, 0, 0], tip: [0, 0, 27], turn, pitch}}});
        q.segments[id - 1]._stykPoseChoice = {group: 'Eyes', label, shown: 27, hidden: 0};
      }
      return {figure_type_id: 1, segments: q.segments, polyfills: [], image_assets: [], text_assets: []};
    };
    const write = (name, figure) => {
      const object = createObject(figure, 1, 100, 100);
      Object.assign(object, {angles: object.angles.map(a => a + 0.6), root_x: 117, scale: 1.8, image_text_flags: 1});
      writeFileSync(`${out}/${name}.document.json`, JSON.stringify({...emptyDocument(), figure_types: [figure], keyframes: [createFrame([object])]}) + '\n');
    };
    write('pose-choices', eyes());
    const presets = eyes();
    for (const segment of presets.segments) delete segment._stykPoseChoice;
    compilePoseChoices(presets, [{name: 'Expression', choices: [
      {label: 'Rest', pose: {}},
      {label: 'Smile', pose: {bend: {Neutral: 0.4}, swing: {Focused: [0.2, -0.3]}, length: {Closed: 18}}},
    ]}]);
    write('pose-presets', presets);
  }
  scenario('pose-choices-sheet', app, [
    ['@select', 1, -1], ['setPoseChoice', 'Eyes', 7], ['setPoseChoice', 'Eyes', 7], ['setPoseChoice', 'Eyes', 10], ['setPoseChoice', 'Eyes', 0], ['setPoseChoice', 'Eyes', 999],
    ['setPoseChoice', 'Mouth', 3], ['beginDrag', 'Expression'], ['setPoseChoice', 'Eyes', 4], ['cancelDrag'], ['@seek', 2], ['setPoseChoice', 'Eyes', 4], ['undo'], ['undo'], ['redo'],
  ], 'pose-choices.document.json');
  scenario('pose-presets-sheet', app, [
    ['@select', 1, -1], ['setPoseChoice', 'Expression', 2], ['setPoseChoice', 'Expression', 2], ['setPoseChoice', 'Expression', 1], ['setPoseChoice', 'Expression', 0],
    ['@select', 1, 3], ['rotateJoint', 0.1], ['@select', 1, -1], ['setPoseChoice', 'Expression', 2], ['undo'], ['undo'], ['redo'],
  ], 'pose-presets.document.json');
  scenario('pose-choice-mechanism-sheet', app, [
    ['@select', 1, -1], ['setPoseChoice', 'Mouth', 18], ['setPoseChoice', 'Mouth', 0], ['setPoseChoice', 'Mouth', 18], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/spatial/mesh-mechanism.json');
  // An IK controller's settings from the inspector: pinned and released (the limb kept as
  // drawn), stretch, chain length and bend side, its target turned (a free limb's branches
  // turning with it), switched off and on, chains that would share bones, and refusals.
  scenario('ik-settings-sheet', app, [
    ['@select', 1, 3], ['setNodeIK', {pinned: true}], ['setNodeIK', {allowStretch: true}], ['setNodeIK', {bendDirection: -1}], ['poseJoint', 240, 330], ['setNodeIK', {bendDirection: 0}],
    ['setNodeIK', {bendDirection: 1}],
    ['setNodeIK', {chainLength: 1}], ['setNodeIK', {chainLength: 99}], ['setNodeIK', {bogus: 1}], ['setNodeIK', {enabled: 'yes'}], ['rotateIKTarget', 0.4],
    ['poseJoint', 250, 300], ['setNodeIK', {pinned: false}], ['rotateIKTarget', -0.3], ['rotateIKTarget', 'x'], ['setNodeIK', {enabled: false}], ['setNodeIK', {enabled: true}],
    ['@select', 1, 2], ['setNodeIK', {enabled: true, chainLength: 1}], ['@select', 1, 1], ['setNodeIK', {enabled: true}], ['setNodeIK', {enabled: true}],
    ['@select', 1, -1], ['setNodeIK', {enabled: true}], ['setNodeIK', {pinned: true}], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  // The same on a figure after the first (a duplicate): the limb is captured from the frame on
  // show, which on a layer sheet holds more figures than the native keyframe.
  scenario('ik-settings-second-figure-sheet', app, [
    ['@select', 1, -1], ['duplicateFigure'], ['@select', 2, 3], ['setNodeIK', {pinned: true}], ['rotateIKTarget', 0.2], ['setNodeIK', {bendDirection: -1}],
    ['setNodeIK', {bendDirection: 0}], ['poseJoint', 540, 330], ['setNodeIK', {pinned: false}], ['poseJoint', 530, 320], ['setNodeIK', {chainLength: 1}],
    ['beginDrag', 'Pose joint'], ['poseJoint', 525, 310], ['commitDrag'], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  scenario('ik-settings-pinned-sheet', app, [
    ['@select', 1, 3], ['setNodeIK', {allowStretch: true}], ['poseJoint', 560, 330], ['setNodeIK', {pinned: false}], ['@select', 1, 5], ['setNodeIK', {chainLength: 1}],
    ['setNodeIK', {bendDirection: 0}], ['rotateIKTarget', 0.5], ['@select', 1, 7], ['setNodeIK', {enabled: false}], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/ik/startup-pinned.json');
  // A planted 3D leg: its swivel (through the pole when it is the only setting), the feet
  // planted and released at once, switched off (its record kept) and on, turned.
  scenario('ik-settings-spatial-sheet', app, [
    ['@select', 1, 9], ['setNodeIK', {swivel: 0.4}], ['setNodeIK', {swivel: 0.2, allowStretch: true}], ['setNodeIK', {swivel: 'x'}], ['setSpatialFeetPinned', false],
    ['setSpatialFeetPinned', true], ['setNodeIK', {enabled: false}], ['setNodeIK', {enabled: true}], ['rotateIKTarget', 0.3], ['setNodeIK', {pinned: false}],
    ['rotateIKTarget', -0.2], ['@select', 1, 3], ['setSpatialFeetPinned', false], ['undo'], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/ik/spatial.json');
  // Pinned controllers whose followers were never stored: configuring one stores the
  // followers its limb is solved with, and every other pinned controller takes its own.
  {
    const document = JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/ik/followers.json', import.meta.url), 'utf8'));
    for (const frame of document.keyframes) for (const object of frame.objects) if (object._stykIK?.['22']) {
      object._stykIK['22'].followers = {};
      object._stykIK['12'] = {enabled: true, pinned: true, allowStretch: false, bendDirection: 1, chainLength: 1, target: {x: object.root_x + 10, y: object.root_y - 40, rotation: 0}, followers: {}};
    }
    writeFileSync(`${out}/ik-settings-followers.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('ik-settings-followers-sheet', app, [
    ['@select', 1, 1], ['setNodeIK', {allowStretch: true}], ['undo'], ['@select', 1, 2], ['setNodeIK', {allowStretch: true}], ['@select', 1, 1], ['setNodeIK', {chainLength: 1}],
    ['setNodeIK', {bendDirection: -1}], ['undo'], ['redo'],
  ], 'ik-settings-followers.document.json');
  // IK is not put on a joint a rig derives (a connector).
  scenario('ik-settings-rig-sheet', app, [
    ['@select', 1, 5], ['setNodeIK', {enabled: true}], ['@select', 1, 2], ['setNodeIK', {enabled: true}], ['setNodeIK', {chainLength: 1}], ['undo'], ['redo'],
  ], 'rig.document.json');
  // The layer list: renamed, coloured (a colour removed, even where there was none, is an
  // entry), shown, hidden and locked (the scene and camera tracks too), created (at the end,
  // first and inactive), reordered and moved; refusals; a gesture after them; history.
  scenario('layer-list-sheet', app, [
    ['renameLayer', 'layer-2', '  Back  '], ['renameLayer', 'scene', 'x'], ['renameLayer', 'layer-9', 'x'], ['renameLayer', 'layer-1', ''],
    ['setLayerColor', ['layer-1', 'layer-2', 'layer-1'], 'violet'], ['setLayerColor', ['layer-2'], null], ['setLayerColor', ['layer-2'], null], ['setLayerColor', ['layer-1'], 'pink'],
    ['setLayerVisible', 'layer-2', false], ['setLayerVisible', 'scene', false], ['setLayerLocked', 'camera', true], ['setLayerLocked', 'layer-1', 'yes'], ['setLayerVisible', 'layer-2', false],
    ['createLayer', 'Front'], ['createLayer', null, {index: 0, activate: false}], ['createLayer', '   '], ['createLayer', 'X', {index: 9}],
    ['reorderLayers', ['layer-2', 'layer-1', 'layer-3', 'layer-4']], ['moveLayerTo', 'layer-1', 0], ['moveLayerTo', 'layer-1', 99], ['reorderLayers', ['layer-1']],
    ['@select', 1, -1], ['moveSelection', 5, 5], ['undo'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'],
  ], 'sheet-layers.document.json');
  // Layer folders: created (with layers, empty, by default name), a layer created inside one
  // and one between two of its layers, layers moved in and out, the stack arranged with and
  // without a move, renamed and ungrouped; refusals; history.
  scenario('layers-folders-sheet', app, [
    ['createLayerFolder', 'Group', ['layer-1']], ['createLayer', 'In', {folderId: 'folder-1'}], ['createLayer', 'Between', {index: 2}], ['createLayerFolder'],
    ['createLayerFolder', null], ['createLayerFolder', 'Bad', ['nope']], ['renameLayerFolder', 'folder-2', 'Empty'], ['renameLayerFolder', 'folder-9', 'x'],
    ['moveLayersToFolder', ['layer-2'], 'folder-1'], ['moveLayersToFolder', ['layer-2']], ['moveLayersToFolder', ['layer-2'], 'folder-9'],
    ['arrangeLayers', ['layer-2', 'layer-1', 'layer-3', 'layer-4']], ['arrangeLayers', ['layer-3', 'layer-2', 'layer-1', 'layer-4'], ['layer-1']],
    ['arrangeLayers', ['layer-4', 'layer-3', 'layer-2', 'layer-1'], ['layer-2'], 'folder-2'],
    ['arrangeLayers', ['layer-1', 'layer-2', 'layer-3', 'layer-4'], ['layer-2'], null], ['arrangeLayers', ['layer-1']],
    ['deleteLayerFolder', 'folder-1'], ['deleteLayerFolder', 'folder-1'], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-layers.document.json');
  // Figures added from the library at the playhead: the first definition, a chosen one, one
  // that does not exist; at a later tick inside a held key; the new figure posed; history.
  scenario('add-figure-sheet', app, [
    ['addFigure'], ['addFigure', 1], ['addFigure', 99], ['@seek', 3], ['addFigure'], ['@select', 4, 3], ['poseJoint', 300, 200], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  scenario('add-figure-layers-sheet', app, [
    ['@select', 3, -1], ['addFigure', 1], ['moveSelection', 20, 10], ['@seek', 6], ['addFigure', 1], ['setLayerLocked', 'layer-2', true], ['addFigure', 1],
    ['setLayerLocked', 'layer-2', false], ['undo'], ['undo'], ['redo'],
  ], 'sheet-layers.document.json');
  // Keys moved and copied along the timeline: a key moved, one copied back, a key made where
  // there was none and moved, a collision with replacing off and one replacing the key it
  // lands on, refusals, several layers at once; and imported keys, captured as poses.
  scenario('move-frames-sheet', app, [
    ['sheetMoveFrames', ['layer-1'], 0, 0, 2], ['sheetMoveFrames', ['layer-1'], 6, 6, -2, {copy: true}], ['sheetMoveFrames', ['layer-2'], 3, 3, 1],
    ['sheetMoveFrames', ['layer-1'], 2, 2, 2, {replace: false}], ['sheetMoveFrames', ['layer-1'], 0, 0, -1], ['sheetMoveFrames', ['layer-1'], 4, 4, 0],
    ['sheetMoveFrames', ['layer-1'], 2, 2, 2],
    ['sheetMoveFrames', ['layer-1', 'layer-2'], 0, 10, 3], ['@seek', 5], ['@select', 1, -1], ['moveSelection', 4, 4], ['undo'], ['undo'], ['redo'],
  ], 'sheet-layers.document.json');
  // The timeline clipboard: a range copied and pasted on its own layer (inside it, the pose
  // after the range kept; past its end; a range holding the layer's end),
  // two layers pasted on each other's rows (new identities, a join following them) and
  // inserted from one layer downwards, the scene's row on itself; refusals (repeated,
  // missing or locked layers, too few layers below, another kind of track, not a whole
  // frame); pasting past a layer's end; history.
  scenario('sheet-clipboard-sheet', app, [
    ['sheetCopyFrames', ['layer-1'], 0, 3], ['sheetPasteFrames', ['layer-1'], 1], ['sheetPasteFrames', ['layer-1'], 4], ['sheetCopyFrames', ['layer-1'], 5, 9], ['sheetPasteFrames', ['layer-1'], 20],
    ['sheetCopyFrames', ['layer-1', 'layer-2'], 0, 6], ['sheetPasteFrames', ['layer-2', 'layer-1'], 10],
    ['sheetPasteFrames', ['layer-1'], 2, {insert: true}], ['sheetPasteFrames', ['layer-2'], 2, {insert: true}], ['sheetPasteFrames', ['layer-1', 'layer-1'], 0], ['sheetPasteFrames', ['scene'], 0],
    ['sheetPasteFrames', ['layer-1', 'layer-2'], 1.5], ['sheetCopyFrames', ['layer-1', 'layer-1'], 0], ['sheetCopyFrames', [], 0], ['sheetCopyFrames', ['nope'], 0],
    ['sheetCopyFrames', ['scene'], 0, 2], ['sheetPasteFrames', ['layer-1'], 3], ['sheetPasteFrames', ['scene'], 3], ['sheetCopyFrames', ['layer-2'], 6, 8],
    ['setLayerLocked', 'layer-2', true], ['sheetPasteFrames', ['layer-2'], 0], ['setLayerLocked', 'layer-2', false], ['sheetPasteFrames', ['layer-2'], 30],
    ['@seek', 12], ['@select', 1, -1], ['moveSelection', 6, 3], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-layers.document.json');
  scenario('sheet-clipboard-empty-sheet', app, [['sheetPasteFrames', ['layer-1'], 0], ['sheetPasteFrames', ['layer-1', 'layer-1'], 0]], 'sheet-layers.document.json');
  // Joined figures with an IK controller whose followers are in the joined figure, pasted
  // on a new layer: identities, joins and followers renamed together.
  scenario('sheet-clipboard-ik-sheet', app, [
    ['createLayer', 'Copy'], ['sheetCopyFrames', ['layer-1'], 0, 4], ['sheetPasteFrames', ['layer-2'], 0], ['@select', 5, 0], ['poseJoint', 340, 290], ['undo'], ['undo'], ['redo'],
  ], 'ik-joined-unpinned.document.json');
  scenario('move-frames-imported-sheet', app, [
    ['sheetMoveFrames', ['layer-1'], 0, 0, 3], ['sheetMoveFrames', ['layer-1'], 3, 8, 2, {copy: true}], ['undo'], ['redo'],
  ], 'startup.document.json');
  // The inspector's figure fields: scale, opacity, name, colour; refusals; several figures
  // selected (shared fields edit them all, others the selected one); history.
  scenario('update-object-sheet', app, [
    ['@select', 1, -1], ['updateObject', {scale: 1.5}], ['updateObject', {field28: 128, name: 'Hero'}], ['updateObject', {scale: -1}], ['updateObject', {scale: 'x'}],
    ['updateObject', {field28: 300}], ['updateObject', {unique_id: 9}], ['updateObject', {color_override_raw: 4278190335}], ['duplicateFigure'], ['selectMany', [1, 2]],
    ['updateObject', {image_text_flags: 1}], ['updateSelection', {root_x: 5}], ['updateObject', {root_x: 300}], ['updateSelection', {name: 'Pair'}], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  scenario('update-object-native', {}, [
    ['@select', 1, -1], ['updateObject', {scale: 0.75, root_y: 100}], ['selectMany', [1, 2]], ['updateObject', {field28: 64}], ['undo'], ['redo'],
  ]);
  // The inspector's segment fields: the joint's angle, length and bend (one posed edit),
  // its colour, transparency, thickness, shape and construction flag (one definition entry),
  // both at once; refusals; history.
  scenario('update-segment-sheet', app, [
    ['@select', 1, 3], ['updateSegment', {angle_rad: 1.2}], ['updateSegment', {length: 40}], ['updateSegment', {bend_rad: 0.3}], ['updateSegment', {color_rgb: [200, 30, 40]}],
    ['updateSegment', {transparency: 128, thickness: 9}], ['updateSegment', {primitive_code: 1}], ['updateSegment', {is_static: true}], ['updateSegment', {angle_rad: 0.5, color_rgb: [0, 0, 255]}],
    ['@select', 1, 2], ['updateSegment', {thickness: 0}], ['@select', 1, 3],
    ['updateSegment', {color_rgb: [300, 0, 0]}], ['updateSegment', {transparency: -1}], ['updateSegment', {primitive_code: 9}], ['updateSegment', {length: -2}],
    ['updateSegment', {parent_id: 1}], ['updateSegment', {thickness: -1}], ['updateSegment', {angle_rad: 'x'}], ['@select', 1, -1], ['updateSegment', {thickness: 3}],
    ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  scenario('update-segment-rig-sheet', app, [
    ['@select', 1, 5], ['updateSegment', {length: 0.4}], ['updateSegment', {length: 2}], ['@select', 1, 2], ['updateSegment', {angle_rad: 2}], ['undo'], ['redo'],
  ], 'rig.document.json');
  // Camera motion clips: moved, retimed past the sheet's end (which lengthens it), switched
  // off, parameters and followed figures changed, muted ranges moving with their clip;
  // refusals (parameter range, property, clip, kind, follow length, a locked camera);
  // deleted; history.
  {
    const document = JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/eval/follow-figures.json', import.meta.url), 'utf8'));
    document._styk.cameraMotion.clips[1].mutedRanges = [{start: 12, end: 16}];
    writeFileSync(`${out}/camera-motion.document.json`, JSON.stringify(document) + '\n');
  }
  {
    const follow = 'motion-00000000-0000-4000-8000-000000000001', shake = 'motion-00000000-0000-4000-8000-000000000002';
    scenario('camera-motion-sheet', app, [
      ['setCameraMotion', shake, {start: 14}], ['setCameraMotion', shake, {params: {strength: 1.5, seed: 7}}], ['setCameraMotion', shake, {enabled: false}],
      ['setCameraMotion', shake, {duration: 80}], ['setCameraMotion', follow, {targets: [{uid: 1, weight: 0.5}]}], ['setCameraMotion', shake, {params: {strength: 9}}],
      ['setCameraMotion', shake, {bogus: 1}], ['setCameraMotion', 'nope', {start: 1}], ['setCameraMotion', shake, {targets: [{uid: 1, weight: 1}]}],
      ['setCameraMotion', follow, {duration: 200000}], ['setCameraMotion', shake, {start: 14}], ['setLayerLocked', 'camera', true], ['setCameraMotion', shake, {start: 3}],
      ['setLayerLocked', 'camera', false], ['deleteCameraMotion', shake], ['deleteCameraMotion', 'nope'], ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'camera-motion.document.json');
  }
  // The project palette: colours added as hex text (short, upper-case) and as bytes, one
  // already there, several at once, reordered (also past the end), removed; refusals.
  scenario('palette-sheet', app, [
    ['addPaletteColor', '#FF0000'], ['addPaletteColor', [0, 128, 255]], ['addPaletteColor', 'abc'], ['addPaletteColor', '#ff0000'], ['addPaletteColor', 'red'],
    ['addPaletteColors', ['#123456', '#ff0000', '#123456', [1, 2, 3]]], ['movePaletteColor', '#123456', 0], ['movePaletteColor', '#123456', 99], ['movePaletteColor', '#999999', 0],
    ['removePaletteColor', '#aabbcc'], ['removePaletteColor', [0, 128, 255]], ['addPaletteColor', [300, 0, 0]], ['addPaletteColors', []], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  // Audio tracks and clips: track name, volume, solo and mute (33 clips sounding at once
  // refused; 32, with 31 ending as one starts or a silent clip, not), clip timing with fades kept within
  // the clip, a clip moved to another track, deletions that drop recordings nothing uses;
  // refusals; a pose gesture in progress committed first; history. And a document
  // without audio. (Recordings are checked when a document opens, and these commands add
  // none, so a faulty recording never reaches them.)
  const audioAsset = (id, duration, extra = {}) => ({id, name: `${id}.wav`, size: 3, duration, chunks: [{data_base64: 'AAAA'}], peaks: [0.25, 1, 0.5], ...extra});
  const audioClip = (id, assetId, start, extra = {}) => ({id, assetId, start, offset: 0, duration: 1, gain: 1, fadeIn: 0, fadeOut: 0, ...extra});
  {
    const document = JSON.parse(readFileSync(`${out}/startup.document.json`, 'utf8'));
    const crowd = [...Array.from({length: 31}, (_, i) => audioClip(`crowd-${i}`, 'sound-c', 0)), audioClip('crowd-late', 'sound-c', 1)];
    document._styk.audio = {version: 1, assets: {'sound-a': audioAsset('sound-a', 2), 'sound-b': audioAsset('sound-b', 1.5, {size: 1, chunks: [{data_base64: 'AA=='}]}), 'sound-c': audioAsset('sound-c', 4)}, tracks: [
      {id: 'audio-a', name: 'Music', gain: 1, mute: false, solo: false, clips: [audioClip('clip-1', 'sound-a', 0, {fadeOut: 0.25}), audioClip('clip-2', 'sound-a', 2)]},
      {id: 'audio-b', name: 'Effects', gain: 0.8, mute: false, solo: false, clips: [audioClip('clip-3', 'sound-b', 0.5, {duration: 1.5})]},
      {id: 'audio-c', name: 'Crowd', gain: 1, mute: true, solo: false, clips: crowd},
    ]};
    writeFileSync(`${out}/audio.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('audio-sheet', app, [
    ['setAudioTrack', 'audio-a', {name: 'Voice', gain: 0.5}], ['setAudioTrack', 'audio-a', {name: 'Voice'}], ['setAudioTrack', 'audio-a', {pan: 1}], ['setAudioTrack', 'nope', {mute: true}],
    ['setAudioTrack', 'audio-b', {solo: true}], ['setAudioTrack', 'audio-a', {gain: 5}], ['setAudioTrack', 'audio-a', {name: '  '}], ['setAudioTrack', 'audio-c', {mute: false}], ['setAudioTrack', 'audio-b', {solo: false}],
    ['setAudioTrack', 'audio-a', {mute: true}], ['setAudioTrack', 'audio-b', {solo: false}], ['setAudioClip', 'crowd-0', {gain: 0}], ['setAudioTrack', 'audio-a', {mute: false}],
    ['setAudioClip', 'clip-1', {start: 1.5, duration: 0.2}], ['setAudioClip', 'clip-1', {start: 1.5}], ['setAudioClip', 'clip-2', {fadeIn: 3}], ['setAudioClip', 'clip-1', {}, 'audio-b'],
    ['setAudioClip', 'clip-1', {gain: 'x'}], ['setAudioClip', 'clip-1', {volume: 1}], ['setAudioClip', 'clip-1', {duration: 99}], ['setAudioClip', 'clip-1', {}, 'nope'],
    ['setAudioClip', 'nope', {start: 0}], ['setAudioClip', 'clip-2', {offset: 1.9, duration: 0.2}],
    ['@select', 1, 3], ['beginDrag', 'Pose joint'], ['poseJoint', 520, 300], ['setAudioTrack', 'audio-a', {gain: 0.7}],
    ['deleteAudioClip', 'clip-3'], ['deleteAudioClip', 'nope'], ['deleteAudioTrack', 'audio-c'], ['deleteAudioTrack', 'nope'], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'audio.document.json');
  scenario('audio-none-sheet', app, [
    ['deleteAudioTrack', 'audio-a'], ['setAudioTrack', 'audio-a', {mute: true}], ['setAudioClip', 'clip-1', {start: 1}], ['deleteAudioClip', 'clip-1'],
  ], 'startup.document.json');
  // Polygons of the selected figure's definition: created (defaults; a closing repeat of
  // the first handle; colour, opacity and order given), reshaped, reordered and deleted;
  // refusals (the same cycle in either direction, too few, repeated or unknown handles,
  // colour, opacity and order out of range, unknown fields, missing polygons); a pose
  // gesture in progress committed first; history.
  scenario('polygons-sheet', app, [
    ['@select', 1, -1], ['addPolygon', [0, 2, 3]], ['addPolygon', [3, 2, 0]], ['addPolygon', [1, 4, 5, 1], {color: '#FF8800', opacity: 0.5, zOrder: 3}],
    ['addPolygon', [1, 1, 2]], ['addPolygon', [1, 2]], ['addPolygon', [1, 2, 999]], ['addPolygon', 'x'], ['addPolygon', [0, 2, 4], {color: 'red'}],
    ['addPolygon', [0, 2, 4], {opacity: 2}], ['addPolygon', [0, 2, 4], {zOrder: 1e39}], ['updatePolygon', 0, {handleIds: [0, 2, 4]}], ['updatePolygon', 0, {zOrder: -5}],
    ['updatePolygon', 0, {handleIds: [5, 4, 1]}], ['updatePolygon', 5, {zOrder: 1}], ['updatePolygon', 0, {fill: 1}], ['updatePolygon', 0, {surface: null}], ['updatePolygon', 0, {}],
    ['removePolygon', 0], ['removePolygon', 9], ['@select', 1, 3], ['beginDrag', 'Pose joint'], ['poseJoint', 520, 300], ['addPolygon', [0, 3, 4]],
    ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  // A definition from a native file: polygons without identities (they take theirs from
  // their place when one is deleted), native order arrays (dropped by any edit), a next
  // identity past the largest (kept for the next polygon).
  {
    const document = JSON.parse(readFileSync(`${out}/startup.document.json`, 'utf8'));
    const figure = document.figure_types[0];
    figure.polyfills = [[0, 2, 3], [1, 4, 5], [6, 7, 8]].map((ids, i) => ({segment_ids: ids, color_rgb: [40 * i, 80, 120], alpha_raw: 0, color_alpha: 1, z_order: -i, z_order_runtime_raw: -i - 1}));
    figure.segment_z_raw = figure.segments.map((_, i) => i);
    figure.poly_z_raw = [0, 1, 2];
    writeFileSync(`${out}/polygons.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('polygons-native-file-sheet', app, [
    ['@select', 1, -1], ['removePolygon', 2], ['addPolygon', [0, 4, 5]], ['removePolygon', 1], ['addPolygon', [0, 7, 8]], ['undo'], ['undo'], ['redo'],
  ], 'polygons.document.json');
  scenario('polygons-native', {}, [
    ['@select', 1, -1], ['addPolygon', [0, 11, 22]], ['addPolygon', [11, 22, 33], {zOrder: 0.5}], ['updatePolygon', 1, {zOrder: 2}], ['updatePolygon', 0, {handleIds: [0, 44, 55]}], ['removePolygon', 1], ['undo'], ['redo'],
  ]);
  // Effect clips: timing, name, switch, strength, fades, a clip lengthening the sheet;
  // trimming a start (keys rebased when time before the source is revealed); order among
  // a target's clips and inside a group; parameters set or keyed (keys present, asked
  // for), switched, toggled, moved, deleted and eased (discrete parameters hold); the
  // gizmo edit committed as one entry, cancelled, and cancelled by undo; refusals
  // (unknown fields, clips, effects and parameters, ranges, stacks, locked layers,
  // occupied key frames); a pose gesture in progress committed first; history.
  {
    const document = JSON.parse(readFileSync(`${out}/startup.document.json`, 'utf8'));
    const glow = createVfxClip({kind: 'figure', uid: 1}, 'glow', 'clip-glow', 'fx-glow', {start: 2, duration: 6});
    glow.keys = {'vfx1:glow:fx-glow:radius': [{tick: 0, value: 4, interpolation: 'linear'}, {tick: 4, value: 20, interpolation: 'linear'}]};
    const tint = createVfxClip({kind: 'figure', uid: 1}, 'tint', 'clip-tint', 'fx-tint');
    const scene = createVfxClip({kind: 'scene'}, 'vignette', 'clip-scene', 'fx-vig', {start: 0, duration: 6});
    const group = {...createVfxClip({kind: 'figure', uid: 1}, 'glow', 'clip-group', 'fx-a', {start: 1, duration: 5}), name: 'Pair'};
    group.effects = [...group.effects, createVfx('outline', 'fx-b')];
    document._styk.vfxClips = {version: 1, clips: [glow, scene, tint, group]};
    writeFileSync(`${out}/vfx-clips.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('vfx-clips-sheet', app, [
    ['setVfxClip', 'clip-glow', {start: 3, name: 'Glow'}], ['setVfxClip', 'clip-glow', {start: 3}], ['setVfxClip', 'clip-glow', {bogus: 1}], ['setVfxClip', 'nope', {start: 1}],
    ['setVfxClip', 'clip-glow', {duration: 0}], ['setVfxClip', 'clip-glow', {strength: 0.5, fadeIn: 2, enabled: false}], ['setVfxClip', 'clip-glow', {duration: 20}],
    ['trimVfxClipStart', 'clip-glow', 6], ['trimVfxClipStart', 'clip-glow', 0], ['trimVfxClipStart', 'clip-tint', 3],
    ['moveVfxClipOrder', 'clip-tint', -1], ['moveVfxClipOrder', 'clip-scene', 1], ['moveVfxClipOrder', 'clip-tint', 2],
    ['@seek', 4], ['setVfxClipParameter', 'clip-glow', 'fx-glow', 'radius', 30], ['setVfxClipParameter', 'clip-tint', 'fx-tint', 'mix', 0.8],
    ['setVfxClipParameter', 'clip-tint', 'fx-tint', 'mix', 5], ['setVfxClipParameter', 'clip-tint', 'fx-tint', 'nope', 1], ['setVfxClipParameter', 'clip-tint', 'fx-x', 'mix', 1],
    ['setVfxClipParameter', 'clip-tint', 'fx-tint', 'enabled', 0], ['setVfxClipParameters', 'clip-tint', 'fx-tint', {mix: 0.3, color: 255}, {key: true}],
    ['toggleVfxClipKey', 'clip-tint', 'vfx1:tint:fx-tint:mix'], ['toggleVfxClipKey', 'clip-tint', 'vfx1:tint:fx-tint:mix'],
    ['moveVfxClipKey', 'clip-tint', 'vfx1:tint:fx-tint:mix', 4, 7], ['moveVfxClipKey', 'clip-tint', 'vfx1:tint:fx-tint:color', 4, 7],
    ['moveVfxClipKeys', 'clip-tint', 7, 9], ['moveVfxClipKeys', 'clip-tint', 9, 9], ['deleteVfxClipKeys', 'clip-tint', 9, {properties: ['vfx1:tint:fx-tint:mix']}],
    ['setVfxClipParameters', 'clip-tint', 'fx-tint', {color: 65280}, {key: true, tick: 2}], ['moveVfxClipKey', 'clip-tint', 'vfx1:tint:fx-tint:color', 2, 9], ['moveVfxClipKeys', 'clip-tint', 2, 9],
    ['setVfxClipEasing', 'clip-glow', 'vfx1:glow:fx-glow:radius', 0, 'ease-in'],
    ['reorderVfxGroupEffect', 'clip-group', 'fx-b', 0], ['reorderVfxGroupEffect', 'clip-group', 'fx-b', 0], ['reorderVfxGroupEffect', 'clip-group', 'fx-z', 0],
    ['setVfxClipParameters', 'clip-group', 'fx-b', {mode: 1}, {key: true}], ['setVfxClipEasing', 'clip-group', 'vfx1:outline:fx-b:mode', 3, 'linear'],
    ['setVfxClip', 'clip-group', {effects: [{version: 2, type: 'nope', id: 'x', enabled: true, params: {}}]}], ['setVfxClip', 'clip-scene', {effects: []}],
    ['setVfxClip', 'clip-tint', {strength: 2}], ['setVfxClip', 'clip-group', {effects: [{version: 2, type: 'tint', id: 'fx-c', enabled: true, params: {bogus: 1}}]}],
    ['setVfxClip', 'clip-group', {effects: [{version: 3, type: 'tint', id: 'fx-c', enabled: true, params: {}}]}],
    ['setVfxClip', 'clip-group', {effects: [{version: 1, type: 'tint', id: 'fx-c', enabled: true, params: {mix: 0.25}}]}],
    ['setLayerLocked', 'layer-1', true], ['setVfxClip', 'clip-glow', {start: 2}], ['setLayerLocked', 'layer-1', false],
    ['beginVfxClipEdit'], ['setVfxClipParameter', 'clip-glow', 'fx-glow', 'intensity', 1.5], ['setVfxClipParameter', 'clip-glow', 'fx-glow', 'intensity', 2], ['commitVfxClipEdit'],
    ['beginVfxClipEdit'], ['setVfxClip', 'clip-tint', {strength: 0.2}], ['cancelVfxClipEdit'], ['beginVfxClipEdit'], ['setVfxClip', 'clip-tint', {strength: 0.4}], ['undo'],
    ['@select', 1, 3], ['beginDrag', 'Pose joint'], ['poseJoint', 520, 300], ['setVfxClip', 'clip-glow', {name: 'Kept'}],
    ['deleteVfxClip', 'clip-scene'], ['deleteVfxClip', 'nope'], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'vfx-clips.document.json');
  // Effect clips added (whole animation, generated effects at the playhead for their usual
  // length with a drawn seed, timing given, scopes, refusals, a locked layer), copied with
  // their effects sampled between number and colour keys, pasted with their keys or values,
  // duplicated after themselves, effects added to a group; identities and seeds drawn by
  // the editor (D18); history.
  {
    const figure = {kind: 'figure', uid: 1}, scene = {kind: 'scene'}, segment = {kind: 'segment', uid: 1, handleId: 22};
    scenario('vfx-clip-add-sheet', app, [
      ['pasteVfxClip', figure], ['@seek', 3], ['addVfxClip', figure, 'glow'], ['addVfxClip', figure, 'particles'], ['addVfxClip', scene, 'smoke', {start: 1, duration: 10}],
      ['addVfxClip', segment, 'aura', {duration: 12}], ['addVfxClip', figure, 'explosion', {includeAttached: false}], ['@seek', 7.5], ['addVfxClip', scene, 'beam'], ['@seek', 3], ['addVfxClip', scene, 'tint', {includeAttached: true}],
      ['addVfxClip', figure, 'bogus'], ['addVfxClip', figure, 'tint', {start: 2}], ['addVfxClip', {kind: 'camera'}, 'tint'],
      ['copyVfxClip', 'clip-glow'], ['pasteVfxClip', figure], ['pasteVfxClip', scene, {animation: false, start: 5}], ['copyVfxClip', 'nope'],
      ['duplicateVfxClip', 'clip-glow'], ['duplicateVfxClip', 'clip-tint'], ['duplicateVfxClip', 'nope'],
      ['@seek', 2], ['setVfxClipParameters', 'clip-tint', 'fx-tint', {color: 255}, {key: true}], ['@seek', 6], ['setVfxClipParameters', 'clip-tint', 'fx-tint', {color: 65280, mix: 0.4}, {key: true}],
      ['@seek', 4], ['copyVfxClip', 'clip-tint'], ['pasteVfxClip', figure, {animation: false}], ['pasteVfxClip', segment, {start: 9}],
      ['addVfxGroupEffect', 'clip-group', 'beam'], ['addVfxGroupEffect', 'clip-group', 'tint'], ['addVfxGroupEffect', 'clip-group', 'bogus'], ['addVfxGroupEffect', 'nope', 'tint'],
      ['setLayerLocked', 'layer-1', true], ['addVfxClip', figure, 'tint'], ['setLayerLocked', 'layer-1', false],
      ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'vfx-clips.document.json');
  }
  // Batches (`movieclipBatch`, as the timeline runs several commands as one): a key extended,
  // easing over two ranges, a batch that records nothing, one that fails half way (its first
  // entry undone), a pose gesture, entries of different kinds; history across them.
  scenario('batch-sheet', app, [
    ['@batch', 'Extend keyframe', [['sheetSetDuration', 3, 'layer-1', 0]]],
    ['@batch', 'Change easing', [['sheetSetEasing', ['layer-1'], 0, 1, {interpolation: 'ease-in'}], ['sheetSetEasing', ['layer-1'], 2, 3, {interpolation: 'linear'}]]],
    ['@batch', 'Nothing', [['select', 1, -1]]],
    ['@batch', 'Fails', [['sheetInsertKey', ['layer-1'], 4], ['sheetSetEasing', ['layer-1'], 0, 1, {interpolation: 'bogus'}]]],
    ['@batch', 'Pose', [['@select', 1, 3], ['beginDrag', 'Pose joint'], ['poseJoint', 520, 300], ['commitDrag']]],
    ['@batch', 'Mixed', [['addPaletteColor', '#123456'], ['seek', 5], ['sheetInsertKey', ['layer-1'], 5]]],
    ['undo'], ['undo'], ['undo'], ['redo'], ['@select', 1, -1], ['moveSelection', 4, 4], ['undo'], ['undo'], ['redo'], ['undo'], ['undo'], ['undo'],
  ], 'startup.document.json');
  // The timeline's layer selection: a layer chosen with its contents selects its figures on
  // show and follows them through seeks and edits, until seeking keeps the selection, a
  // figure is selected on the canvas or another layer is chosen; the scene's row, a layer
  // that does not exist, choosing without contents; the active layer set alone; undo
  // restoring a followed selection a canvas click had dropped; the same figures selected in
  // another order (kept); a layer whose first figure is joined to another.
  scenario('sheet-selection-sheet', app, [
    ['selectSheetLayer', 'layer-1'], ['seek', 6], ['selectSheetLayer', 'layer-2'], ['seek', 3], ['moveSelection', 5, 5], ['keepSelectionOnSeek'], ['seek', 0],
    ['selectSheetLayer', 'scene'], ['selectSheetLayer', 'nope'], ['selectSheetLayer', 'layer-1', {contents: false}], ['seek', 6], ['selectSheetLayer', 'layer-2'], ['select', 1, -1], ['seek', 3],
    ['setActiveLayer', 'layer-2'], ['setActiveLayer', 'layer-2'], ['setActiveLayer', 'nope'],
    ['selectSheetLayer', 'layer-1'], ['moveSelection', 3, 3], ['seek', 2], ['undo'], ['seek', 5], ['redo'], ['seek', 1],
    ['@seek', 8], ['@select', 1, -1], ['addFigure', 1], ['selectSheetLayer', 'layer-1'], ['seek', 2], ['seek', 9], ['keepSelectionOnSeek'], ['seek', 2], ['seek', 9],
    ['selectSheetLayer', 'layer-1'], ['moveSelection', 2, 2], ['select', 1, -1], ['undo'], ['seek', 2], ['selectMany', [2, 1]], ['selectSheetLayer', 'layer-1'],
    ['seek', 9], ['@select', 1, -1], ['joinTo', 4, 0], ['selectSheetLayer', 'layer-1'],
  ], 'sheet-layers.document.json');
  // The figure clipboard: nothing to paste; a figure copied and pasted (a copy of its
  // definition, each paste further along; as an instance in place; a unique copy in
  // front), two joined figures together, one joined to a figure left out (unjoined where
  // drawn), on another layer, cut and pasted back, duplicated (the clipboard kept, its
  // layer kept, also when another layer is active), pasted at a later frame; refusals;
  // history.
  scenario('figure-clipboard-sheet', app, [
    ['pasteSelection'], ['@select', 1, -1], ['copySelection'], ['pasteSelection'], ['pasteSelection'], ['pasteSelection', {pasteMode: 'instance', offset: 0}],
    ['selectMany', [1, 2]], ['copySelection'], ['pasteSelection', {pasteMode: 'unique', pasteDepth: 'front'}],
    ['pasteSelection', {pasteMode: 'bogus'}], ['pasteSelection', {pasteDepth: 'x'}], ['pasteSelection', {offset: 'x'}],
    ['@select', 3, -1], ['copySelection'], ['setActiveLayer', 'layer-2'], ['pasteSelection'], ['@select', 2, -1], ['cutSelection'], ['pasteSelection'],
    ['@select', 1, -1], ['duplicateSelection'], ['pasteSelection'], ['duplicateSelection', {offset: 10}], ['@seek', 3], ['pasteSelection'],
    ['@select', 3, -1], ['setActiveLayer', 'layer-1'], ['duplicateSelection'], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-layers.document.json');
  // Effects on a node of the copied figure follow it to its new definition.
  {
    const document = JSON.parse(readFileSync(`${out}/startup.document.json`, 'utf8'));
    document.keyframes[0].objects[0]._stykVfx = {figure: [createVfx('tint', 'fx-whole')], '1/3': [createVfx('glow', 'fx-node')], '*/5': [createVfx('outline', 'fx-any')]};
    writeFileSync(`${out}/figure-vfx.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('figure-clipboard-vfx-sheet', app, [
    ['@select', 1, -1], ['copySelection'], ['pasteSelection'], ['pasteSelection', {pasteMode: 'instance'}], ['undo'], ['undo'], ['redo'],
  ], 'figure-vfx.document.json');
  scenario('figure-clipboard-ik-sheet', app, [
    ['selectMany', [2, 3]], ['copySelection'], ['pasteSelection', {pasteMode: 'instance'}], ['@select', 5, 0], ['poseJoint', 340, 290], ['undo'], ['undo'], ['redo'],
  ], 'ik-joined-unpinned.document.json');
  // Project settings: frame rate, canvas size, both from the settings dialog; unchanged
  // values; refusals; history. And a format 4 document, which also stores the frame delay.
  scenario('project-settings-sheet', app, [
    ['setFPS', 30], ['setFPS', 30], ['setFPS', 0], ['setFPS', 1.5], ['setCanvasSize', 1280, 720], ['setCanvasSize', 0, 5], ['updateProject', {fps: 12, canvas_width: 640}],
    ['updateProject', {name: 'x'}], ['updateProject', {canvas_height: 0}], ['updateProject', {fps: 2000}], ['updateProject', {}], ['updateProject', {canvas_height: 480}], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  {
    const document = JSON.parse(readFileSync(`${out}/startup.document.json`, 'utf8'));
    document.version = 4; document.frame_delay_ms = 42;
    writeFileSync(`${out}/format4.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('project-settings-format4-sheet', app, [['setFPS', 25], ['updateProject', {fps: 7}], ['undo'], ['undo'], ['redo']], 'format4.document.json');
  // Importing figures: a file's first frame centred on the canvas, a chain of joined figures
  // (centred on its unjoined root, joins kept) at a position, a single definition; a file without figures, a bad position;
  // history.
  {
    const file = JSON.parse(readFileSync(`${out}/two-limbs.document.json`, 'utf8')), chain = JSON.parse(readFileSync(`${out}/joined-chain.document.json`, 'utf8'));
    // A file whose joins name their parent by slot only, as older ones do.
    const bySlot = structuredClone(chain); for (const object of bySlot.keyframes[0].objects) if (object.join) delete object.join.target_unique_id;
    scenario('import-figure-sheet', app, [
      ['importFigure', file], ['importFigure', chain, {position: {x: 300, y: 200}}], ['importFigure', bySlot], ['importFigure', file.figure_types[1], {position: {x: 100, y: 120}}], ['importFigure', {figure_types: []}],
      ['importFigure', file, {position: {x: 'a', y: 0}}], ['moveSelection', 5, 5], ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'startup.document.json');
  }
  // Layer parallax: switched on with linked axes (the other axis following the one given),
  // unlinked, its reference the camera on show (also where the camera has moved); refusals;
  // history.
  scenario('layer-parallax-sheet', app, [
    ['setLayerParallax', 'layer-2', {enabled: true, x: 0.5}], ['setLayerParallax', 'layer-2', {y: 2}], ['setLayerParallax', 'layer-2', {linked: false, x: 1}],
    ['setLayerParallax', 'layer-2', {y: 3}], ['setLayerParallax', 'layer-2', {x: 5}], ['setLayerParallax', 'layer-2', {foo: 1}], ['setLayerParallax', 'scene', {x: 1}],
    ['setLayerParallax', 'layer-2', {reference: {x: 10, y: 'a'}}], ['setLayerLocked', 'layer-2', true], ['setLayerParallax', 'layer-2', {x: 1}], ['setLayerLocked', 'layer-2', false],
    ['undo'], ['undo'], ['redo'],
  ], 'sheet-layers.document.json');
  {
    const document = JSON.parse(readFileSync(`${out}/sheet-layers.document.json`, 'utf8'));
    for (const frame of document.keyframes) frame.camera = {is_default: false, x: 40, y: -20, scale: 1, angle_rad: 0};
    writeFileSync(`${out}/parallax-camera.document.json`, JSON.stringify(document) + '\n');
  }
  scenario('layer-parallax-camera-sheet', app, [['setLayerParallax', 'layer-1', {enabled: true}], ['undo'], ['redo']], 'parallax-camera.document.json');
  // Renaming a movieclip: trimmed, unchanged, too long or empty, a figure that is not one;
  // history.
  scenario('movieclip-rename-sheet', app, [
    ['@seek', 3], ['@select', 4, -1], ['renameMovieclip', '  Walk cycle  '], ['renameMovieclip', 'Walk cycle'], ['renameMovieclip', '   '], ['renameMovieclip', 'x'.repeat(121)],
    ['renameMovieclip', 12], ['@select', 1, -1], ['renameMovieclip', 'Nope'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-movieclip.document.json');
  // A movieclip instance's playback on the frame on show: mode, speed and offset, restart
  // keys; refusals (speed, mode, placement, clock, restart order, a figure that is not a
  // movieclip, a drawing the clip does not have); history.
  scenario('movieclip-playback-sheet', app, [
    ['@seek', 3], ['@select', 4, -1], ['setMovieclipPlayback', {speed: 0}], ['setMovieclipPlayback', {mode: 'x'}], ['setMovieclipPlayback', {start: -1}],
    ['setMovieclipPlayback', {clock: 'x'}], ['setMovieclipPlayback', {restarts: [{tick: 5, offset: 0}, {tick: 2, offset: 0}]}], ['setMovieclipPlayback', {restarts: [{tick: 2, offset: 1}]}],
    ['setMovieclipPlayback', {speed: 2}], ['setMovieclipPlayback', {mode: 'once'}],
    ['setMovieclipDrawing', 4, 0, 0], ['undo'], ['undo'], ['redo'], ['@select', 1, -1], ['setMovieclipPlayback', {mode: 'once'}],
  ], 'sheet-movieclip.document.json');
  // A clip on the document's clock: its placement and restart keys.
  scenario('movieclip-playback-timed-sheet', app, [
    ['@seek', 3], ['@select', 4, -1], ['setMovieclipPlayback', {start: -1}], ['setMovieclipPlayback', {end: 1}], ['setMovieclipPlayback', {start: 2, end: 2}],
    ['setMovieclipPlayback', {restarts: [{tick: 5, offset: 0}, {tick: 2, offset: 0}]}], ['setMovieclipPlayback', {restarts: [{tick: 2, offset: -1}]}],
    ['setMovieclipPlayback', {restarts: [{tick: 2, offset: 1}, {tick: 4, offset: 0}]}], ['setMovieclipPlayback', {start: 2, end: 6, speed: 1.5}], ['undo'], ['redo'],
  ], 'sheet-movieclip-timed.document.json');
  // Frames dragged to another row of the timeline: moved, copied back, refusals (a layer that
  // does not exist, a locked one); the clipboard left as it was (nothing to paste after);
  // history.
  scenario('sheet-transfer-sheet', app, [
    ['sheetTransferFrames', ['layer-1'], ['layer-2'], 0, 3, 8], ['sheetTransferFrames', ['layer-2'], ['layer-1'], 8, 9, 12, {copy: true}], ['sheetPasteFrames', ['layer-1'], 0],
    ['sheetTransferFrames', ['layer-1'], ['nope'], 0, 1, 2], ['setLayerLocked', 'layer-2', true], ['sheetTransferFrames', ['layer-1'], ['layer-2'], 0, 1, 2],
    ['setLayerLocked', 'layer-2', false], ['undo'], ['undo'], ['undo'], ['redo'],
  ], 'sheet-layers.document.json');
  scenario('layers-native', {}, [
    ['setLayerVisible', 'layer-1', false], ['createLayer', 'Second'], ['renameLayer', 'layer-1', 'Main'], ['moveLayerTo', 'layer-2', 0], ['undo'], ['undo'], ['redo'],
  ]);
  // The start document with a copy joined to a hand, then unjoined.
  scenario('startup-join-sheet', app, [
    ['@select', 1, -1], ['duplicateFigure'], ['joinTo', 1, 4], ['@select', 1, 3], ['poseJoint', 520, 300], ['@select', 2, 3], ['poseJoint', 560, 320],
    ['@select', 2, -1], ['unjoinFigure'], ['undo'], ['undo'], ['redo'],
  ], 'startup.document.json');
  // Pinned chains of four bones (FABRIK), on Both and on one side.
  scenario('ik-chains-sheet', app, [
    ['@select', 1, -1], ['moveSelection', 15, 10], ['@select', 2, -1], ['rotateSelection', 0.2], ['@select', 1, 1], ['rotateJoint', 0.2],
    ['@select', 2, 3], ['poseJoint', 600, 300], ['@seek', 6], ['@select', 1, 0], ['bendJoint', 230, 140], ['undo'], ['undo'], ['redo'],
  ], '../../crates/styk-eval/tests/fixtures/ik/chain-long.json');
  // Handle Edit Mode: handles moved with the arcs kept, bends edited from either end, figures
  // joined at a handle moving with it, a root moved, a gesture returned to its start and
  // cancelled, a handle that changed mid-gesture, a joined root (refused); history.
  {
    const start = (uid, joint, options = {}) => {
      const e = open(JSON.parse(readFileSync(`${out}/joined-chain.document.json`, 'utf8')), options);
      if (options.layerTimeline) e.seek(3);
      e.select(uid, joint); e.beginHandleEditDrag(); const {x, y} = e._drag.handleEdit.point; e.cancelHandleEditDrag();
      return [x, y];
    };
    scenario('handle-edit-native', {}, [
      ['@select', 2, 1], ['editHandlePosition', 330, 300], ['@select', 1, 0], ['editHandlePosition', 240, 260, {bend: true}],
      ['@select', 1, 2], ['beginHandleEditDrag'], ['editHandlePosition', 300, 260], ['editHandlePosition', 310, 270, {bend: true}], ['commitHandleEditDrag'],
      ['@select', 1, -1], ['editHandlePosition', 180, 170], ['@select', 2, -1], ['editHandlePosition', 10, 10],
      ['@select', 3, 0], ['beginHandleEditDrag', {bend: true}], ['editHandlePosition', 400, 300], ['editHandlePosition', ...start(3, 0)], ['editHandlePosition', 420, 310],
      ['editHandlePosition', ...start(3, 0)], ['commitHandleEditDrag'], ['beginHandleEditDrag'], ['editHandlePosition', 410, 290], ['cancelHandleEditDrag'],
      ['beginHandleEditDrag', {label: 'Move handle'}], ['@select', 3, 1], ['editHandlePosition', 5, 5], ['commitHandleEditDrag'],
      ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'joined-chain.document.json');
    scenario('handle-edit-sheet', app, [
      ['@seek', 3], ['@select', 2, 1], ['editHandlePosition', 330, 300], ['@select', 1, 1], ['beginHandleEditDrag', {bend: true}], ['editHandlePosition', 280, 240],
      ['editHandlePosition', 285, 250, {bend: false}], ['commitHandleEditDrag'], ['@select', 3, 0], ['beginHandleEditDrag'], ['editHandlePosition', 400, 330],
      ['editHandlePosition', ...start(3, 0, app)], ['commitHandleEditDrag'], ['@seek', 6], ['@select', 1, -1], ['editHandlePosition', 200, 150],
      ['undo'], ['undo'], ['redo'],
    ], 'joined-chain.document.json');
    // Pinned limbs (the solved angles and stretched lengths), Stick Nodes curves.
    scenario('handle-edit-ik-sheet', app, [
      ['@select', 1, 0], ['editHandlePosition', 300, 230], ['@select', 1, 2], ['editHandlePosition', 420, 300, {bend: true}], ['@select', 2, 1], ['editHandlePosition', 690, 300],
      ['@seek', 1], ['@select', 1, 1], ['beginHandleEditDrag', {bend: true}], ['editHandlePosition', 400, 280], ['commitHandleEditDrag'], ['undo'], ['redo'],
    ], '../../crates/styk-eval/tests/fixtures/ik/stretch.json');
    scenario('handle-edit-chain-sheet', app, [
      ['@select', 1, 1], ['editHandlePosition', 260, 200], ['@select', 2, 2], ['editHandlePosition', 560, 220, {bend: true}], ['undo'], ['redo'],
    ], '../../crates/styk-eval/tests/fixtures/ik/chain-long.json');
    scenario('handle-edit-sticknodes-sheet', app, [
      ['@select', 1, 0], ['editHandlePosition', 330, 230], ['@select', 1, 1], ['editHandlePosition', 300, 300, {bend: true}], ['@select', 1, 2], ['editHandlePosition', 280, 330],
      ['undo'], ['redo'], ['undo'], ['undo'], ['undo'], ['bendJoint', 320, 240], ['@select', 1, 2], ['editHandlePosition', 285, 325],
    ], 'sticknodes.document.json');
    // A segment bent past a full turn: its chord points away from its start angle.
    writeFileSync(`${out}/full-turn.document.json`, JSON.stringify(documentOf([[[11, 0, 90, .8], [22, 11, 90, 2, {bend_rad: 7}], [33, 22, 35, 0]]])) + '\n');
    scenario('handle-edit-full-turn-sheet', app, [
      ['@select', 1, 1], ['editHandlePosition', 330, 260], ['editHandlePosition', 335, 250, {bend: true}], ['undo'], ['redo'],
    ], 'full-turn.document.json');
    // Whole figures turned and scaled by a handle about the dragged figure's origin: joined
    // figures follow, the selection orbits it, crossings of a half turn accumulate, Ctrl keeps
    // the scale and Shift the angle, back at the start the figures are as they were.
    scenario('figure-transform-native', {}, [
      ['@select', 1, 1], ['transformFigureHandle', 330, 260], ['beginFigureHandleDrag', 250, 120], ['transformFigureHandle', 150, 170],
      ['transformFigureHandle', 200, 260], ['transformFigureHandle', 280, 200], ['transformFigureHandle', 260, 110, {ctrlKey: true}], ['transformFigureHandle', 240, 100, {shiftKey: true}],
      ['commitFigureHandleDrag'], ['beginFigureHandleDrag', 250, 120, {rotate: false}], ['transformFigureHandle', 150, 170], ['transformFigureHandle', 250, 120], ['commitFigureHandleDrag'],
      ['beginFigureHandleDrag', null, null, {scale: false, label: 'Turn figure'}], ['transformFigureHandle', 120, 200], ['cancelFigureHandleDrag'],
      ['beginFigureHandleDrag', 200, 170], ['@select', 1, -1], ['transformFigureHandle', 10, 10], ['selectMany', [3, 1]], ['beginFigureHandleDrag', null, null, {joint: 1}], ['transformFigureHandle', 260, 300],
      ['commitFigureHandleDrag'], ['@select', 1, 1], ['beginFigureHandleDrag'], ['@select', 2, 1], ['transformFigureHandle', 300, 300], ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'joined-chain.document.json');
    scenario('figure-transform-sheet', app, [
      ['@seek', 3], ['@select', 2, 1], ['transformFigureHandle', 400, 300], ['@select', 1, 2], ['beginFigureHandleDrag'], ['transformFigureHandle', 260, 330],
      ['transformFigureHandle', 150, 120, {shiftKey: true}], ['transformFigureHandle', 170, 110, {rotate: false}], ['commitFigureHandleDrag'], ['@seek', 6], ['@select', 3, 1], ['transformFigureHandle', 500, 260],
      ['@seek', 4], ['@select', 2, 1], ['beginFigureHandleDrag', 330.5, 260.25], ['transformFigureHandle', 280, 300], ['transformFigureHandle', 330.5, 260.25], ['commitFigureHandleDrag'], ['undo'], ['undo'], ['redo'],
      ['@seek', 0], ['@select', 3, -1], ['unjoinFigure'], ['moveSelection', 101.37, 13.11], ['selectMany', [3, 1]], ['beginFigureHandleDrag', 250.3, 120.7, {joint: 1}], ['transformFigureHandle', 170, 190],
      ['transformFigureHandle', 250.3, 120.7], ['commitFigureHandleDrag'],
    ], 'joined-chain.document.json');
    scenario('figure-transform-ik-sheet', app, [
      ['@select', 1, 1], ['transformFigureHandle', 330, 260], ['@select', 2, 2], ['transformFigureHandle', 640, 330, {ctrlKey: true}], ['undo'], ['redo'],
    ], '../../crates/styk-eval/tests/fixtures/ik/stretch.json');
    // Handle commands: nudged by screen pixels through the view (zoomed, turned, mirrored),
    // aligned to an axis, posed, bent, stretched, edited or turning the whole figure, a handle
    // chosen by figure and joint or handle number, moved to where it is on the neighbouring key;
    // segment values read, typed (relative to the incoming tangent), copied and pasted.
    const handleSteps = [
      ['@select', 1, 1], ['nudgeHandle', 5, -3], ['nudgeHandle', 2, 0, {bend: true}], ['nudgeHandle', 0, 4, {stretch: true}], ['nudgeHandle', 3, 3, {view: {scale: 2}}],
      ['nudgeHandle', -4, 2, {view: {scale: 1.5, rotation: 0.3, flip: true}}], ['nudgeHandle', 2, 2, {editMode: true}], ['nudgeHandle', 1, -2, {wholeFigure: true}], ['nudgeHandle', 0, 0],
      ['nudgeHandle', 3, 1, {uid: 2, jointIndex: 2}], ['nudgeHandle', 3, 1, {uid: 3, handleId: 22}], ['nudgeHandle', 5, 5, {uid: 1, handleId: 0}], ['nudgeHandle', 5, 5, {uid: 1, handleId: 0, editMode: true}],
      ['nudgeHandle', 1, 1, {uid: 99}], ['nudgeHandle', 1, 1, {uid: 1, handleId: 77}], ['nudgeHandle', 1, 1, {view: {scale: 0}}],
      ['@select', 1, 2], ['alignHandle', 1, 0], ['alignHandle', 0, -1, {wholeFigure: true}], ['alignHandle', 1, 1, {bend: true}], ['alignHandle', -1, 0, {editMode: true}], ['alignHandle', 0, 0],
      ['@select', 1, -1], ['alignHandle', 1, 0],
      ['@select', 2, 1], ['segmentValues'], ['segmentValues', {relative: true}], ['setSegmentValues', {angle: 45}], ['setSegmentValues', {bend: 20, length: 80}], ['setSegmentValues', {angle: 10}, {relative: true}],
      ['setSegmentValues', {length: 0}], ['setSegmentValues', {foo: 1}], ['setSegmentValues', {angle: 10}, {relative: true}],
      ['beginSegmentValueEdit', {editMode: true}], ['setSegmentValues', {angle: 30, length: 60}], ['setSegmentValues', {bend: 15}], ['commitDrag'],
      ['beginSegmentValueEdit', {isolate: true}], ['setSegmentValues', {angle: -20}], ['cancelDrag'], ['@select', 3, 2], ['setSegmentValues', {length: 50}],
      ['copySegmentValues'], ['@select', 3, 1], ['pasteSegmentValues'], ['pasteSegmentValues', '12,5:abc:3:70'], ['pasteSegmentValues', '1:2:-3'], ['pasteSegmentValues', 'x'.repeat(101)],
      ['@select', 1, 1], ['locateEditedHandle', -1], ['locateEditedHandle', 1], ['locateEditedHandle', 2], ['locateEditedHandle', -1, {handleId: 0}], ['locateEditedHandle', 1, {uid: 2, jointIndex: 1}],
      ['@select', 3, 0], ['segmentValues', {relative: true}], ['setSegmentValues', {angle: 25}, {relative: true}], ['beginDrag', 'Pose figure'], ['poseJoint', 330, 330], ['locateEditedHandle', -1],
      ['undo'], ['undo'], ['undo'], ['redo'], ['selectMany', [1, 3]], ['nudgeHandle', 2, 2, {uid: 1, handleId: 0}],
      ['@select', 1, 1], ['beginDrag', 'Pose figure'], ['poseJoint', 300, 330], ['locateEditedHandle', 1], ['undo'],
    ];
    scenario('handle-commands-native', {}, [['@seek', 6], ...handleSteps], 'joined-chain.document.json');
    scenario('handle-commands-sheet', app, [['@seek', 6], ...handleSteps, ['@seek', 3], ['@select', 2, 2], ['nudgeHandle', 4, 4], ['setSegmentValues', {angle: 90, bend: 5}], ['undo'], ['redo']], 'joined-chain.document.json');
    // An omitted argument reads the real segment clipboard; explicit null is
    // passed to parseSegmentValues and refuses before touching a live gesture.
    const segmentClipboardSteps = [
      ['pasteSegmentValues', null], ['@select', 3, 2], ['copySegmentValues'], ['@select', 3, 1],
      ['pasteSegmentValues', null], ['segmentValues'], ['pasteSegmentValues'], ['undo'], ['redo'],
      ['pasteSegmentValues', null, {relative: true}],
      ['beginSegmentValueEdit'], ['setSegmentValues', {angle: 27, bend: 9, length: 62}],
      ['pasteSegmentValues', null], ['segmentValues'], ['cancelDrag'],
      ['beginSegmentValueEdit'], ['setSegmentValues', {angle: -13, bend: -6, length: 47}],
      ['pasteSegmentValues', null], ['commitDrag'], ['undo'], ['redo'],
      ['pasteSegmentValues', false], ['pasteSegmentValues', 0], ['pasteSegmentValues', {}],
      ['pasteSegmentValues', ''], ['pasteSegmentValues', '12.5:0:58'], ['undo'], ['redo'],
      ['pasteSegmentValues'], ['undo'], ['redo'],
    ];
    scenario('segment-clipboard-native', {}, segmentClipboardSteps, 'joined-chain.document.json');
    scenario('segment-clipboard-sheet', app, segmentClipboardSteps, 'joined-chain.document.json');
    // Through a turned, zoomed camera, and a camera motion clip that does not move it here.
    {
      const document = JSON.parse(readFileSync(`${out}/joined-chain.document.json`, 'utf8'));
      document.keyframes[0].camera = {is_default: false, x: 30, y: -12, scale: 1.25, angle_rad: 0.2};
      document.keyframes[1].camera = {is_default: false, x: -20, y: 8, scale: 0.8, angle_rad: -0.3};
      const motion = JSON.parse(readFileSync(`${out}/camera-motion.document.json`, 'utf8'))._styk.cameraMotion;
      document._styk = {...document._styk, cameraMotion: {...motion, clips: motion.clips.filter(clip => clip.type === 'shake').map(clip => ({...clip, start: 3, duration: 1}))}};
      writeFileSync(`${out}/camera-chain.document.json`, JSON.stringify(document) + '\n');
    }
    const cameraSteps = [['@select', 1, 1], ['nudgeHandle', 5, -3], ['nudgeHandle', 4, 2, {view: {scale: 2, rotation: -0.4}}], ['nudgeHandle', 3, 3, {cameraEnabled: false}], ['@select', 1, -1], ['nudgeHandle', -6, 2], ['@seek', 6], ['@select', 2, 1], ['nudgeHandle', 2, 7], ['@seek', 4], ['nudgeHandle', 1, 2], ['undo'], ['redo']];
    scenario('handle-commands-camera-native', {}, cameraSteps, 'camera-chain.document.json');
    scenario('handle-commands-camera-sheet', app, cameraSteps, 'camera-chain.document.json');
    // Camera motion clips moving the camera where handles are nudged and the camera is baked:
    // each preset, overlapping, a muted range, a seed at the top of its range.
    {
      const document = JSON.parse(readFileSync(`${out}/camera-chain.document.json`, 'utf8'));
      const clips = [
        {...createCameraMotion('shake', 'motion-shake', 0, 40), params: {...createCameraMotion('shake', 'x').params, seed: 2147483600}},
        {...createCameraMotion('impact', 'motion-impact', 2, 30), params: {...createCameraMotion('impact', 'x').params, direction: 30}},
        {...createCameraMotion('wobble', 'motion-wobble', 4, 40), params: {...createCameraMotion('wobble', 'x').params, phase: 45}},
        createCameraMotion('pulse', 'motion-pulse', 1, 50),
        {...createCameraMotion('handheld', 'motion-handheld', 5, 50), mutedRanges: [{start: 6, end: 7}, {start: 40, end: 45}]},
      ];
      document._styk = {...document._styk, cameraMotion: {version: 1, clips}};
      writeFileSync(`${out}/camera-motion-chain.document.json`, JSON.stringify(document) + '\n');
    }
    scenario('camera-motion-handles-sheet', app, [
      ...cameraSteps, ['@seek', 2], ['@select', 1, 1], ['nudgeHandle', 3, -2], ['nudgeHandle', 2, 1, {view: {scale: 1.5, rotation: 0.3, flip: true}}], ['@seek', 3], ['nudgeHandle', -4, 1],
      ['@seek', 5], ['@select', 2, 1], ['nudgeHandle', 1, 3], ['@seek', 6], ['nudgeHandle', 2, 2], ['@seek', 7], ['nudgeHandle', -1, -1],
      ['applyCameraToFigures', [0], {ticks: [1, 2, 3, 4, 5, 6, 7]}], ['@seek', 3], ['applyCameraToFigures'], ['undo'], ['undo'], ['redo'], ['undo'],
      ['sheetInsertFrames', ['layer-1'], 6, 56], ['applyCameraToFigures', [0], {ticks: Array.from({length: 61}, (_, i) => i + 1)}], ['undo'], ['redo'],
    ], 'camera-motion-chain.document.json');
    // Camera commands on a layer sheet: values copied, typed (one key or several, refusals),
    // transformed, reset, pasted, aligned with the canvas view, taken from the neighbouring key;
    // camera drags previewed, committed, cancelled, begun by a move, ended by another command;
    // a handle's figure moved to where the handle is on the neighbouring key.
    scenario('camera-commands-sheet', app, [
      ['pasteCamera'], ['copyCamera'], ['setCameraValues', {x: 40}], ['setCameraValues', {scale: 1.5, angle_rad: 0.1}, [0, 1]], ['setCameraValues', {x: 40}, [0, 1]], ['setCameraValues', {}], ['setCameraValues', {bogus: 1}],
      ['setCameraValues', {x: 'a'}], ['setCameraValues', {scale: -1}], ['setCameraValues', {x: 1e40}], ['setCameraValues', {x: 1}, [7]], ['transformCamera', {x: 5, y: -3, angle_rad: 0.05, scale: 1.1}],
      ['resetCamera'], ['resetCamera'], ['copyCamera'], ['undo'], ['undo'], ['pasteCamera'], ['@seek', 3], ['setCameraValues', {y: 12}], ['alignCameraToView', {x: 20, y: 10, scale: 1.2, width: 800, height: 600}],
      ['alignCameraToView', {x: 0, y: 0, scale: 0, width: 1, height: 1}], ['@seek', 0], ['locateCamera', 1], ['locateCamera', -1, 'rotation'], ['locateCamera', 1, 'bogus'], ['locateCamera', 3], ['@seek', 6], ['locateCamera', -1, 'rotation'], ['locateCamera', -1, 'scale'], ['locateCamera', -1, 'pose'], ['@seek', 0],
      ['beginCameraDrag'], ['updateCameraDrag', {x: 10, y: 5}], ['updateCameraDrag', {x: 20, scale: 1.2}], ['updateCameraDrag', {angle_rad: 0.1}, {fromStart: false}], ['commitCameraDrag'],
      ['beginCameraDrag'], ['updateCameraDrag', {x: 10}], ['updateCameraDrag', {y: 5}], ['copyCamera'], ['cancelCameraDrag'], ['beginCameraDrag', {indices: [0, 1], label: 'Pan camera'}], ['updateCameraDrag', {x: -15}], ['cancelCameraDrag'], ['updateCameraDrag', {y: 7}], ['commitDrag'],
      ['updateCameraDrag', {bogus: 1}], ['beginCameraDrag'], ['updateCameraDrag', {x: 3}], ['setCameraValues', {x: 1}], ['beginCameraDrag'], ['commitCameraDrag'], ['copyCamera'],
      ['@seek', 6], ['@select', 3, -1], ['locateHandle', -1, {uid: 2, jointIndex: 2}], ['@select', 1, 1], ['locateHandle', -1], ['locateHandle', 1], ['locateHandle', -1, {handleId: 0}], ['locateHandle', -1, {uid: 2, jointIndex: 1, editMode: true}], ['locateHandle', 5],
      ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'camera-chain.document.json');
    // The camera baked into the figures: each figure keyed where the camera shows it and the
    // camera keyed back to the identity, at the playhead, on chosen keyframes or ticks; frames
    // whose camera is already the identity left alone; refusals; a hidden camera track.
    scenario('camera-bake-sheet', app, [
      ['applyCameraToFigures'], ['applyCameraToFigures'], ['@seek', 6], ['applyCameraToFigures', [0, 1]], ['setCameraValues', {x: 25, angle_rad: -0.2, scale: 0.9}, [0, 1]],
      ['applyCameraToFigures', [0], {ticks: [2, 4]}], ['applyCameraToFigures', [5]], ['applyCameraToFigures', [0], {ticks: [1.5]}], ['applyCameraToFigures', [0], {ticks: [99]}], ['applyCameraToFigures', [7], {ticks: [2]}],
      ['setLayerVisible', 'camera', false], ['applyCameraToFigures'], ['setLayerVisible', 'camera', true], ['undo'], ['undo'], ['undo'], ['redo'],
    ], 'camera-chain.document.json');
    scenario('handle-commands-ik-sheet', app, [
      ['@select', 1, 1], ['nudgeHandle', 6, 2], ['segmentValues', {relative: true}], ['setSegmentValues', {angle: 20}, {relative: true}], ['@select', 1, 2], ['alignHandle', 0, 1],
      ['@select', 2, 1], ['setSegmentValues', {length: 70}], ['undo'], ['redo'],
    ], '../../crates/styk-eval/tests/fixtures/ik/stretch.json');
    scenario('handle-edit-startup-sheet', app, [
      ['@select', 1, 3], ['editHandlePosition', 520, 300], ['@select', 1, 0], ['editHandlePosition', 470, 260, {bend: true}], ['undo'], ['redo'],
    ], 'startup.document.json');
  }
}
// Property edits on a layer sheet (inspector scrubs, keyed values, scene colours, effects).
await import('./edit-scenarios-property.mjs');
// Motion-path edits on a layer sheet (trail points dragged at their own ticks, falloffs).
await import('./edit-scenarios-motion-path.mjs');
// Whole-figure animation-origin gestures; topology and scalar channels stay gated.
await import('./edit-scenarios-origin.mjs');

await import('./edit-scenarios-origin-topology.mjs');

await import('./edit-scenarios-origin-pose.mjs');
await import('./edit-scenarios-origin-channels.mjs');
await import('./origin-channels-guard-fixtures.mjs');

await import('./edit-scenarios-camera-bake-order.mjs');

await import('./edit-scenarios-camera-follow.mjs');

await import('./edit-scenarios-measured-bounds.mjs');

await import('./edit-scenarios-motion-path-joined.mjs');

await import('./edit-scenarios-joined-spatial-ik.mjs');

await import('./edit-scenarios-branch-thickness.mjs');

await import('./edit-scenarios-native-builder.mjs');

await import('./edit-scenarios-sprite-segment.mjs');

await import('./edit-scenarios-draw-capacity.mjs');

await import('./edit-scenarios-draw-new-figure.mjs');
await import('./edit-scenarios-origin-range.mjs');
await import('./edit-scenarios-origin-join.mjs');
await import('./edit-scenarios-origin-rig.mjs');
await import('./edit-scenarios-origin-rig-pose.mjs');
await import('./edit-scenarios-origin-rig-inactive.mjs');
await import('./edit-scenarios-origin-angle-lock.mjs');
await import('./edit-scenarios-origin-pose-choice.mjs');
await import('./origin-rig-invalid-fixtures.mjs');

// Movieclip definitions, sparse capture and editable conversion.
await import('./edit-scenarios-movieclips.mjs');
await import('./edit-scenarios-movieclips-native.mjs');
await import('./edit-scenarios-selection-metadata.mjs');
await import('./edit-scenarios-native-transform-channels.mjs');

// Remote-time motion previews and commits retain original animation pivots.
await import('./edit-scenarios-origin-motion.mjs');

// Same-call IK capture: an updated continuity reference feeds the second capture.
// Invalid patch priority and refusal preserve the document/history before either capture.
for (const [name, joint, chainLength, document] of [
  ['ik-capture-double-2d-sheet', 3, 1, 'startup.document.json'],
  ['ik-capture-double-spatial-sheet', 9, 2, '../../crates/styk-eval/tests/fixtures/ik/spatial.json'],
]) {
  scenario(name, {layerTimeline: true, propertyChannels: true}, [
    ['@select', 1, joint], ['setNodeIK', {chainLength, bendDirection: 0}], ['@frame'],
    ['undo'], ['@frame'], ['redo'], ['@frame'],
    ['setNodeIK', {bogus: 1, chainLength: 99, enabled: 'yes', bendDirection: 0}], ['@frame'],
    ['setNodeIK', {chainLength: 99, enabled: 'yes', bendDirection: 0}], ['@frame'],
    ['setNodeIK', {enabled: 'yes', bendDirection: 0}], ['@frame'],
    ['setNodeIK', {enabled: false}], ['@frame'],
    ['setNodeIK', {enabled: true, pinned: false, chainLength, bendDirection: 0}], ['@frame'],
    ['undo'], ['@frame'], ['redo'], ['@frame'],
    ['@select', 1, -1], ['setNodeIK', {chainLength, bendDirection: 0}], ['@frame'],
    ['@select', 1, joint], ['undo'], ['@frame'], ['redo'], ['@frame'],
  ], document);
}
