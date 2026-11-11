import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

function fixture({autoKey = true} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 10, 20].map(x => createFrame([createObject(figure, 1, x, 200), createObject(figure, 2, 100 + x, 200)], 10));
  const editor = ownedEditorFor({demo: false, propertyChannels: true, layerTimeline: true}, report);
  const layer = editor.createLayer('Effects'); editor.assignFiguresToLayer([2], layer.id);
  editor.sheetSetEasing(['layer-1'], 0, 20, {interpolation: 'constant'});
  editor.autoKey = autoKey; return editor;
}
const x = (editor, tick, uid = 1) => { editor.seek(tick, {allowBeyondEnd: true}); return editor.evaluatedFrame.objects.find(o => o.unique_id === uid).root_x; };
const keys = (editor, id = 'layer-1') => editor.layerFrameKeys(id).map(key => key.tick);

test('auto key off keeps editing the held key; on, a held-cell edit keys the playhead', () => {
  const off = fixture({autoKey: false});
  off.seek(5); off.select(1); off.updateObject({root_x: 42});
  assert.deepEqual(keys(off), [0, 10, 20]);
  assert.equal(x(off, 0), 42);

  const on = fixture();
  on.seek(5); on.select(1);
  const before = on.serialize();
  on.updateObject({root_x: 42});
  assert.deepEqual(keys(on), [0, 5, 10, 20]);
  assert.equal(x(on, 0), 0, 'the preceding key keeps its pose');
  assert.equal(x(on, 5), 42); assert.equal(x(on, 9), 42);
  assert.equal(on.layerFrameKeys('layer-1').find(key => key.tick === 5).interpolation, 'constant', 'the new key inherits the hold');
  assert.deepEqual(keys(on, 'layer-2'), [0, 10, 20], 'other layers are not keyed');
  on.undo(); assert.deepEqual(on.serialize(), before, 'one undo step');
});

test('auto key keys canvas pose drags and property edits at the playhead', () => {
  const editor = fixture();
  editor.seek(3); editor.select(1, 0);
  editor.beginDrag('Pose joint'); editor.poseJoint(300, 100); editor.commitDrag();
  assert.deepEqual(keys(editor), [0, 3, 10, 20]);
  editor.seek(7); editor.select(1);
  editor.beginAnimationEdit({kind: 'figure', uid: 1}, 'x'); editor.previewAnimationEdit(64); editor.commitAnimationEdit();
  assert.deepEqual(keys(editor), [0, 3, 7, 10, 20]);
  assert.equal(x(editor, 7), 64);
  // Editing exactly on a key still edits that key.
  editor.seek(7); editor.select(1); editor.updateObject({root_x: 70});
  assert.deepEqual(keys(editor), [0, 3, 7, 10, 20]); assert.equal(x(editor, 7), 70);
});

test('auto key keys the camera at the playhead', () => {
  const editor = fixture();
  editor.sheetSetEasing(['camera'], 0, 20, {interpolation: 'constant'});
  const cameraKeys = () => editor.layerFrameKeys('camera').map(key => key.tick);
  const before = cameraKeys();
  editor.seek(6);
  editor.setCameraValues({x: 40});
  assert.ok(cameraKeys().includes(6), `camera keyed at the playhead: ${cameraKeys()}`);
  assert.ok(before.every(tick => cameraKeys().includes(tick)));
});

test('auto key keys unanimated effect values at the playhead', () => {
  const editor = fixture(), id = editor.addVfxClip({kind: 'figure', uid: 1}, 'glow');
  const effect = editor.getVfxClips()[0].effects[0];
  editor.seek(8); editor.setVfxClipParameter(id, effect.id, 'radius', 30);
  const channel = Object.values(editor.getVfxClips()[0].keys)[0];
  assert.deepEqual(channel.map(key => [key.tick, key.value]), [[8, 30]]);
  const plain = fixture({autoKey: false}), plainId = plain.addVfxClip({kind: 'figure', uid: 1}, 'glow');
  plain.seek(8); plain.setVfxClipParameter(plainId, plain.getVfxClips()[0].effects[0].id, 'radius', 30);
  assert.deepEqual(plain.getVfxClips()[0].keys, {});
});
