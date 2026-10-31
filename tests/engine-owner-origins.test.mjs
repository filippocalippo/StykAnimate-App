// Commands on a document with animation origins run in the engine session (docs/engine/editing.md): they leave the
// document, the history labels and what undo and redo give back exactly as the editor alone gave (the frozen references of
// tests/support/owner-references.mjs), and the session refuses none of them. Each case runs the calls on an editor the
// engine owns and compares them with what an editor it does not own gave.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {canonical, ownerReferences} from './support/owner-references.mjs';

const refs = ownerReferences(import.meta.url);
const folder = new URL('../engine/tests/edit/', import.meta.url);
const OPTIONS = {demo: false, layerTimeline: true, propertyChannels: true};
const fixture = name => JSON.parse(readFileSync(new URL(`${name}.document.json`, folder), 'utf8'));
/** The document as the editor holds it, pivots included (only its derived pose caches are left out). */
const text = (editor, digits) => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : digits && typeof value === 'number' ? Number(value.toPrecision(digits)) : value);

/** Each step is `[method, ...arguments]` or a function of the editor; the editor's answer and the document after it are kept. */
async function trace(document, steps, digits) {
  const editor = new Editor(OPTIONS).load(structuredClone(document));
  const owner = installEngineOwner(editor);
  try {
    const kept = [text(editor, digits)];
    const settle = async (label, answer) => {
      let value, error = null;
      try { value = JSON.stringify((await answer()) ?? null); } catch (caught) { error = caught.messageKey ?? caught.message; }
      kept.push({label, value, error, undo: editor.undoLabel, redo: editor.redoLabel, document: text(editor, digits)});
    };
    for (const step of steps) {
      if (typeof step === 'function') await settle('function', () => step(editor));
      else await settle(step[0], () => editor[step[0]](...step.slice(1)));
    }
    // Everything the steps did is undone, then done again.
    const depth = [];
    while (editor.canUndo) { depth.push(editor.undoLabel); await settle('undo', () => editor.undo()); }
    for (let step = depth.length; step > 0; step--) await settle('redo', () => editor.redo());
    return {kept, refused: Object.keys(owner.refused), depth: depth.length};
  } finally { owner.release(); }
}

/** The steps give the same document, answers and history in the owned editor as the references of an editor alone, and the session takes every call.
 * `digits`: numbers are compared to that many digits, where an IK solution may differ in its last bits between the two solvers. */
async function agree(take, document, steps, {digits} = {}) {
  const alone = take('alone');
  const owned = await trace(document, steps, digits), ownedKept = canonical(owned.kept);
  assert.equal(ownedKept.length, alone.kept.length);
  alone.kept.forEach((entry, at) => assert.deepEqual(ownedKept[at], entry, `step ${at} (${entry.label ?? 'start'})`));
  assert.deepEqual(owned.refused, [], 'the session refused a call');
  assert.ok(alone.depth > 0, 'the steps changed the document');
  return alone;
}

const originDocument = () => fixture('origin-pose-support-sheet');
/** A property edit as the inspector runs it: begin, scrub, commit (the editor's own edit object is not compared). */
const scrub = (target, property, value) => editor => {
  editor.beginAnimationEdit(target, property);
  editor.previewAnimationEdit(value);
  return editor.commitAnimationEdit();
};

refs.test('layers, palette, project, camera and scene commands run in the session on an origin document', {skip: !engineBuilt}, async take => {
  await agree(take, originDocument(), [
    ['addPaletteColor', '#12ab34'], ['addPaletteColors', ['#223344', '#ff0000']], ['movePaletteColor', '#223344', 0], ['removePaletteColor', '#12ab34'],
    ['createLayer', 'Extra'], ['renameLayer', 'layer-1', '  Hero  '], ['setLayerColor', ['layer-1'], 'violet'], ['setLayerVisible', 'layer-1', false],
    ['setLayerVisible', 'layer-1', true], ['setLayerLocked', 'layer-1', true], ['setLayerLocked', 'layer-1', false], ['createLayerFolder', 'Group', ['layer-1']],
    ['moveLayerTo', 'layer-2', 0], ['setLayerParallax', 'layer-2', {enabled: true, x: 0.5}],
    ['setFPS', 30], ['setCanvasSize', 1280, 720], ['updateProject', {fps: 12}],
    ['setCameraValues', {x: 40}], ['copyCamera'], ['resetCamera'], ['pasteCamera'], ['transformCamera', {x: 5, y: -3, angle_rad: 0.05, scale: 1.1}],
    ['setSceneColor', 4280303712], ['setBackgroundColor', 4294901760],
  ]);
});

refs.test('frame timing and keys run in the session on an origin document', {skip: !engineBuilt}, async take => {
  await agree(take, originDocument(), [
    ['seek', 2], ['sheetDuplicateFrameAfter'], ['sheetInsertFrames', ['layer-1'], 2, 2], ['sheetSetDuration', 3], ['sheetAppendFrame'],
    ['sheetInsertKey', ['layer-1'], 4], ['sheetSetEasing', ['layer-1'], 0, 4, {interpolation: 'hold'}], ['sheetClearKeys', ['layer-1'], 4, 4],
    ['sheetRemoveFrames', ['layer-1'], 1, 1], ['sheetClearFrames', ['layer-1'], 5, 5],
    e => { e.sheetCopyFrames(['layer-1'], 0, 3); }, ['sheetPasteFrames', ['layer-1'], 6], ['sheetMoveFrames', ['layer-1'], 0, 1, 2], ['sheetTransferFrames', ['layer-1'], ['layer-1'], 0, 1, 7, {copy: true}],
  ]);
});

refs.test('figures are edited, copied and removed in the session; the pivots follow where they now stand', {skip: !engineBuilt}, async take => {
  await agree(take, originDocument(), [
    ['select', 1, -1], ['updateObject', {scale: 1.5}], ['updateObject', {root_x: 300, root_y: 210}], ['duplicateFigure'],
    ['select', 1, -1], ['copySelection'], ['pasteSelection', {offset: 12}], ['duplicateSelection', {offset: 10}],
    ['select', 1, 2], ['nudgeHandle', 5, -3], ['setSegmentValues', {angle: 45}],
    ['select', 1, -1], ['moveSelectionInFrames', 15, -5, [0, 1]], ['addFigureInFrames', 1, [0], {x: 100, y: 120}], ['duplicateInFrames', [0], {ticks: [0, 3]}],
    ['select', 1, -1], ['setCameraValues', {x: 25, angle_rad: -0.2, scale: 0.9}, [0, 1]], ['applyCameraToFigures', [0, 1]],
    ['select', 3, -1], ['cutSelection'], ['pasteSelection'], ['deleteFiguresInFrames', [0], {ticks: [2]}],
  ]);
});

refs.test('a flip of a branch of an origin figure runs in the session', {skip: !engineBuilt}, async take => {
  await agree(take, originDocument(), [
    ['select', 1, 2], ['mirrorSelection', 'horizontal'], ['mirrorFigure', 'vertical'], ['select', 2, 3], ['mirrorSelection', 'vertical'], ['select', 1, -1], ['mirrorFigure', 'horizontal'],
  ]);
});

refs.test('rig relationships and IK limbs of origin figures are posed in the session', {skip: !engineBuilt}, async take => {
  await agree(take, fixture('origin-rig-pose-support-sheet'), [
    ['seek', 4], ['select', 2, 4], ['setNodeIK', {enabled: true, chainLength: 3}],
    ['select', 1, 2], ['poseJoint', 233.7, 228.35, {stretch: true, snap: false}], ['rotateJoint', 0.23], ['bendJoint', 241.9, 227.2, {stretch: true, snap: false}],
    ['select', 1, 3], ['poseJoint', 325, 270, {stretch: true, snap: false}], ['select', 1, 5], ['slideConnector', 272.7, 264.3], ['setConnectorPosition', 0.75],
    ['select', 1, 2], ['beginFigureHandleDrag'], ['transformFigureHandle', 300, 200], ['commitFigureHandleDrag'],
  ], {digits: 9});
});

refs.test('the Rig tool edits the relationships of an origin figure in the session', {skip: !engineBuilt}, async take => {
  await agree(take, fixture('origin-rig-pose-support-sheet'), [
    ['seek', 3.5], ['select', 1, 2], ['beginRigDrag', {reposition: false}], ['editRigJoint', 266, 210, {stretch: true}], ['commitRigDrag'],
    ['beginRigDrag', {reposition: true}], ['editRigJoint', 290.4, 187.1], ['cancelRigDrag'],
  ]);
});

refs.test('rig patches and angle locks of origin figures with IK limbs run in the session', {skip: !engineBuilt}, async take => {
  await agree(take, fixture('origin-angle-lock-support-sheet'), [
    ['seek', 3.5], ['select', 2, 4], ['setNodeIK', {enabled: true, chainLength: 2}],
    ['select', 1, 3], ['setRigBehavior', {response: {mode: 'rigid'}}], ['setRigBehavior', {orientation: 'world'}], ['setAngleLock', 'figure'], ['setAngleLock', 'parent'], ['setSecondaryAngleReference', 33], ['setAngleLock', 'off'],
    ['select', 1, 2], ['enableSmartStretch', true], ['setRigBehavior', {stretch: {min: 0.5, width: 'scale'}}], ['enableSmartStretch', false],
  ]);
});

refs.test('animation keys of every property, the camera and the scene run in the session on an origin document', {skip: !engineBuilt}, async take => {
  await agree(take, originDocument(), [
    ['select', 1, -1], ['seek', 3],
    scrub({kind: 'figure', uid: 1}, 'opacity', 0.5),
    scrub({kind: 'figure', uid: 1}, 'color', 4281368768),
    scrub({kind: 'figure', uid: 1}, 'outlineWidth', 3),
    scrub({kind: 'figure', uid: 2}, 'zIndex', 2),
    scrub({kind: 'segment', uid: 1, handleId: 22}, 'thickness', 9),
    scrub({kind: 'camera'}, 'x', 40),
    scrub({kind: 'scene'}, 'color', 4280303712),
    ['addAnimationKeys', [{target: {kind: 'figure', uid: 2}, property: 'opacity', tick: 4, value: 0.35}, {target: {kind: 'camera'}, property: 'scale', tick: 2, value: 1.5}]],
    ['addAnimationKey', {kind: 'layer', id: 'layer-1'}, 'pose', 5],
  ]);
});

refs.test('pose keys of a figure the frame does not hold, and of a figure it does, run in the session on an origin document', {skip: !engineBuilt}, async take => {
  await agree(take, originDocument(), [
    ['select', 1, -1],
    ['addAnimationKey', {kind: 'figure', uid: 3}, 'x', 7, 580], ['addAnimationKey', {kind: 'figure', uid: 99}, 'rotation', 4, 0.5],
    ['addAnimationKey', {kind: 'figure', uid: 1}, 'rotation', 4, 0.5], ['addAnimationKeys', [{target: {kind: 'figure', uid: 2}, property: 'x', tick: 6, value: 430}, {target: {kind: 'figure', uid: 1}, property: 'scale', tick: 6, value: 1.2}]],
    ['seek', 5], scrub({kind: 'figure', uid: 1}, 'y', 200),
    scrub({kind: 'figure', uid: 2}, 'rotation', 0.4),
  ]);
});

refs.test('the motion path of the camera is edited in the session on an origin document', {skip: !engineBuilt}, async take => {
  await agree(take, originDocument(), [
    ['seek', 2], ['select', 1, -1], ['beginTranslationDrag'], ['moveSelection', 4, 3],
    ['beginMotionPathEdit', {kind: 'camera'}, 3], ['updateMotionPathEdit', {x: 420, y: 300}], ['commitMotionPathEdit'],
    ['beginMotionPathEdit', {kind: 'camera'}, 2, {falloff: {radius: 4, shape: 'smooth'}}], ['updateMotionPathEdit', {x: 400, y: 320}], ['commitMotionPathEdit'],
    ['beginMotionPathEdit', {kind: 'camera'}, 5], ['updateMotionPathEdit', {x: 390, y: 280}], ['cancelMotionPathEdit'],
  ]);
});

refs.test('IK limbs of origin figures are edited across frames in the session', {skip: !engineBuilt}, async take => {
  await agree(take, fixture('origin-pose-support-free-sheet'), [
    ['select', 2, -1], ['unjoinFigure'], ['joinTo', 1, 55], ['select', 1, -1], ['rotateFiguresInFrames', 0.17, [0], {ticks: [0, 4]}], ['mirrorFiguresInFrames', 'horizontal', [0], {ticks: [2]}], ['scaleFiguresInFrames', 1.2, [0], {ticks: [4]}],
    ['centerFiguresInFrames', [0], {ticks: [4]}], ['resetPoseInFrames', [0], {ticks: [2]}], ['updateFiguresInFrames', {opacity: 0.5}, [0]],
    ['select', 2, -1], ['detachFiguresInFrames', [0], {ticks: [0, 2]}], ['joinFiguresInFrames', 1, 55, [0], {ticks: [0]}], ['deleteFiguresInFrames', [0], {ticks: [4]}],
    ['moveSelectionInFrames', 6, -4, [0, 1]], ['duplicateInFrames', [0], {ticks: [2]}],
  ], {digits: 9});
});

refs.test('a pose choice is changed in the session on an origin figure with a joint, several figures or IK', {skip: !engineBuilt}, async take => {
  await agree(take, fixture('origin-pose-choice-mixed-support-sheet'), [
    ['seek', 3], ['select', 1, 3], ['setPoseChoice', 'Expression', 2], ['setPoseChoice', 'Eyes', 7],
    ['select', 1, -1], ['setPoseChoice', 'Expression', 1], ['selectMany', [1]], ['setPoseChoice', 'Eyes', 4],
    ['select', 1, 4], ['setNodeIK', {enabled: true, chainLength: 2}], ['setPoseChoice', 'Expression', 2],
  ], {digits: 9});
});

refs.test('an origin document with saved property channels runs its commands in the session', {skip: !engineBuilt}, async take => {
  await agree(take, fixture('origin-channels-saved-layout-sheet'), [
    ['addPaletteColor', '#12ab34'], ['createLayer', 'Extra'], ['setFPS', 30], ['setCameraValues', {x: 40}],
    ['seek', 3], ['select', 1, 2], ['beginFigureHandleDrag'], ['transformFigureHandle', 300, 200], ['commitFigureHandleDrag'],
    ['select', 1, 3], ['poseJoint', 330, 260], ['rotateJoint', 0.2], ['updateObject', {scale: 1.2}], ['duplicateFigure'],
    ['select', 1, -1], ['setOrigin', 55], ['select', 1, 4], ['mirrorSegmentBranch', 'horizontal'], ['splitSegment', 0.35], ['addSegment', {parentId: 55, length: 27.125, angle: 0.19}],
    ['select', 1, 6], ['duplicateSegment', {axis: 'horizontal'}], ['deleteSegment', {branch: true}],
  ], {digits: 9});
});

refs.test('keys of a figure whose rig appears in a later pose run in the session beside an origin figure', {skip: !engineBuilt}, async take => {
  const target = uid => ({kind: 'figure', uid});
  await agree(take, fixture('origin-future-rig-sheet'), [['select', 1, -1], ['addAnimationKey', target(3), 'rotation', 8, 0.47], ['addAnimationKeys', [{target: target(3), property: 'rotation', tick: 8, value: 0.31}]], scrub(target(3), 'rotation', 0.2)]);
  await agree(take, fixture('origin-future-rig-joined-sheet'), [['select', 1, -1], ['addAnimationKey', target(2), 'x', 8, 410.75], ['addAnimationKeys', [{target: target(2), property: 'x', tick: 8, value: 405}]], ['moveSelectionInFrames', 4.25, -2.125, [1]]]);
  await agree(take, fixture('origin-changing-rig-sheet'), [['select', 1, -1], ['addAnimationKey', target(3), 'rotation', 8, 0.47], ['rotateFiguresInFrames', 0.27, [1], {uids: [3], ticks: [8]}]]);
});

refs.test('a movieclip holding figures with IK limbs, rigs and origins breaks apart in the session', {skip: !engineBuilt}, async take => {
  const selectClip = editor => {
    const clip = editor.evaluatedFrame.objects.find(object => editor.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id)?._styk?.movieclip);
    editor.select(clip.unique_id, -1);
  };
  const breakApart = [['seek', 2], ['selectMany', [1, 2]], ['createMovieclip', {start: 0, end: 6, replace: true, name: 'Clip'}], ['seek', 3], selectClip, ['breakApartMovieclip']];
  await agree(take, fixture('origin-pose-support-pinned-sheet'), breakApart, {digits: 9});
  await agree(take, fixture('origin-rig-pose-support-sheet'), breakApart, {digits: 9});
});
