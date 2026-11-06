import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

const figureTarget = {kind: 'figure', uid: 1};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
/** `change(report)` writes into the document before it opens; `owned: false` leaves the editor to itself. */
function fixture({change, owned = true} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 100, 0].map((x, i) => createFrame([createObject(figure, 1, x, 200), createObject(figure, 2, 300 + i * 10, 200)], 10));
  report.keyframes.forEach(frame => { frame.unknown_native = {sentinel: 123}; });
  change?.(report);
  return owned ? ownedEditorFor({demo: false}, report) : new Editor({demo: false}).load(report);
}

test('scalar previews are bounded, one history entry on commit, and restore exactly on cancellation', () => {
  const editor = fixture(), frames = editor.report.keyframes, before = structuredClone(frames);
  editor.seek(4); editor.beginAnimationEdit(figureTarget, 'x');
  for (let value = 120; value < 220; value++) editor.previewAnimationEdit(value);
  assert.equal(editor._undo.length, 0); assert.equal(editor.report.keyframes, frames); assert.deepEqual(frames, before);
  near(editor.evaluatedFrame.objects[0].root_x, 219); editor.commitAnimationEdit(); assert.equal(editor._undo.length, 1);
  const animation = structuredClone(editor.report._styk.animation);
  editor.beginAnimationEdit(figureTarget, 'x'); editor.previewAnimationEdit(450); editor.cancelAnimationEdit();
  assert.deepEqual(editor.report._styk.animation, animation); assert.equal(editor._undo.length, 1);
  assert.throws(() => editor.previewAnimationEdit(0), /Begin/);
});

test('camera/scene and extended-duration keys evaluate through the common editor geometry path', () => {
  const editor = fixture();
  editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 0, interpolation: 'linear'}, {target: {kind: 'camera'}, property: 'x', tick: 40, value: 80},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff000000, interpolation: 'linear'}, {target: {kind: 'scene'}, property: 'color', tick: 40, value: 0xffffffff}]);
  assert.equal(editor.totalTicks, 41); editor.seek(30);
  near(editor.evaluatedFrame.camera.x, 60); assert.equal(editor.evaluatedFrame._stykBackgroundColor, 0xffbfbfbf);
  assert.equal(editor.report.keyframes.length, 3);
});

test('loading a missing pose source rejects atomically before replacing the open document', () => {
  const editor = fixture(), report = editor.report, invalid = editor.serialize();
  invalid._styk.animation = {version: 1, nextKeyId: 2, channels: [{id: 'camera::pose', target: {kind: 'camera'}, property: 'pose',
    keys: [{id: 'key-1', tick: 0, value: {frameId: 'frame-missing'}, interpolation: 'hold'}]}]};
  assert.throws(() => editor.load(invalid), /missing source frame/); assert.equal(editor.report, report);
});

