// Command-replay scenarios on documents with property channels (docs/engine/editing.md):
// the commands styk-edit runs, on documents saved with channels as the app holds them (a
// layer sheet whose imported keys sample `legacyAnimation`), from the channel fixtures
// (engine/tools/channel-fixtures.mjs). Run by engine/tools/edit-scenarios.mjs.
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';

const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const fixture = name => `../../crates/styk-eval/tests/fixtures/channels/channels-${name}.sheet.json`;
const scenario = (name, steps, document) => writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor: app, steps}, null, 1) + '\n');
const figure = uid => ({kind: 'figure', uid});

// Scale, rotation, opacity, colour, depth and the position of a joined figure on channels.
scenario('channels-figure-sheet', [
  ['@select', 1, -1], ['moveSelection', 20, 5], ['@seek', 5], ['rotateSelection', 0.3], ['@select', 2, 1], ['poseJoint', 380, 260], ['rotateJoint', 0.2],
  ['@seek', 12], ['@select', 3, -1], ['moveSelection', -10, 10], ['@select', 3, 2], ['bendJoint', 300, 240],
  ['@select', 1, 0], ['beginDrag', 'Pose figure'], ['poseJoint', 240, 200], ['poseJoint', 245, 205], ['commitDrag'],
  ['undo'], ['undo'], ['redo'],
  ['sheetInsertKey', ['layer-1'], 18], ['sheetInsertFrames', ['layer-1'], 3, 2], ['sheetSetEasing', ['layer-1'], 0, 4, {interpolation: 'ease-in'}],
  ['sheetMoveFrames', ['layer-1'], 10, 10, 2], ['undo'], ['undo'],
  ['@select', 2, -1], ['duplicateFigure'], ['deleteSelection'], ['undo'],
  ['beginAnimationEdit', figure(2), 'scale'], ['previewAnimationEdit', 1.4], ['commitAnimationEdit'],
  ['addAnimationKeys', [{target: figure(1), property: 'opacity', tick: 7, value: 0.5}, {target: figure(3), property: 'x', tick: 9, value: 150}]],
  ['undo'], ['redo'],
], fixture('figure'));
// Pose channels: a layer's track, a figure's track with a hidden key and its native
// appearance, a joined figure, the camera's and the scene's poses.
scenario('channels-pose-sheet', [
  ['@select', 2, -1], ['moveSelection', 15, -5], ['@seek', 7], ['rotateSelection', -0.2], ['@seek', 11], ['@select', 3, 1], ['poseJoint', 400, 300],
  ['@select', 4, -1], ['moveSelection', -20, 0], ['@seek', 13], ['@select', 1, -1], ['scaleSelection', 1.2],
  ['undo'], ['redo'], ['sheetInsertKey', ['layer-2'], 5], ['sheetClearKeys', ['layer-1'], 6], ['sheetCopyFrames', ['layer-1'], 0, 4], ['sheetPasteFrames', ['layer-1'], 12],
  ['undo'], ['undo'], ['undo'],
  ['beginAnimationEdit', {kind: 'camera'}, 'y'], ['previewAnimationEdit', -12], ['commitAnimationEdit'], ['setSceneColor', 0xff304050],
  ['undo'], ['undo'], ['redo'],
], fixture('pose'));
// Effects keyed by channels: parameters on the stacks channels add, scrubbed and keyed.
scenario('channels-vfx-sheet', [
  ['@select', 1, -1], ['moveSelection', 10, 10], ['@seek', 6], ['rotateSelection', 0.4], ['@select', 2, 1], ['poseJoint', 420, 260],
  ['setVfxParameter', figure(1), 'fx-00000000000040008000000000000001', 'radius', 4],
  ['beginAnimationEdit', figure(1), 'vfx1:blur:fx-00000000000040008000000000000001:radius', {exactTarget: true}], ['previewAnimationEdit', 10], ['commitAnimationEdit'],
  ['@seek', 9], ['setVfxParameter', {kind: 'scene'}, 'fx-00000000000040008000000000000003', 'contrast', 1.3],
  ['undo'], ['undo'], ['redo'], ['duplicateFigure'], ['undo'],
], fixture('vfx'));
// The camera's channels with Auto curves and a held key; the scene's colour and background.
scenario('channels-camera-scene-sheet', [
  ['@select', 1, -1], ['moveSelection', 12, 4], ['@seek', 5], ['@select', 2, 1], ['rotateJoint', 0.3],
  ['beginAnimationEdit', {kind: 'camera'}, 'scale'], ['previewAnimationEdit', 1.2], ['commitAnimationEdit'],
  ['setSceneColor', 0xff102040], ['@seek', 9], ['setSceneBackground', 0], ['sheetInsertFrames', ['layer-1'], 4, 1],
  ['undo'], ['undo'], ['undo'], ['redo'],
], fixture('camera-scene'));
// A movieclip captured on the native timeline: masked poses, the instance's pose track.
scenario('channels-movieclip-sheet', [
  ['@select', 1, -1], ['moveSelection', 8, 8], ['@seek', 5], ['@select', 2, -1], ['moveSelection', -12, 6], ['@seek', 12], ['@select', 1, 1], ['rotateJoint', 0.25],
  ['undo'], ['undo'], ['redo'], ['sheetInsertKey', ['layer-1'], 6], ['undo'],
], fixture('movieclip'));
// Segment and polygon styles keyed by channels; a polygon's opacity and a width keyed again.
scenario('channels-style-sheet', [
  ['@select', 1, -1], ['moveSelection', 5, 15], ['@seek', 4], ['updatePolygon', 0, {opacity: 0.3}],
  ['beginAnimationEdit', {kind: 'segment', uid: 1, handleId: 22}, 'thickness'], ['previewAnimationEdit', 6], ['commitAnimationEdit'],
  ['@seek', 8], ['@select', 2, 2], ['poseJoint', 470, 230], ['undo'], ['undo'], ['redo'],
], fixture('style'));
// Curves as imported files carry them, and keys past the last native key.
scenario('channels-curves-sheet', [
  ['@select', 1, -1], ['@seek', 4], ['moveSelection', 10, -10], ['@seek', 20], ['rotateSelection', 0.5], ['@seek', 27], ['@select', 2, -1], ['moveSelection', 6, 6],
  ['undo'], ['redo'], ['sheetRemoveFrames', ['layer-1'], 10, 11], ['undo'],
], fixture('curves'));
// Outline channels and a follow camera over channels.
scenario('channels-outline-sheet', [
  ['@select', 1, -1], ['@seek', 6], ['moveSelection', 9, 3], ['updateFigureStyle', {outlineWidth: 4}], ['undo'], ['redo'],
], fixture('outline'));
scenario('channels-follow-sheet', [
  ['@select', 2, -1], ['@seek', 16], ['moveSelection', 20, -6], ['@select', 1, 1], ['rotateJoint', -0.3], ['undo'], ['redo'],
], fixture('follow'));
