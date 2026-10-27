import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {engineEditor} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  const parent = createObject(figure, 1, 300, 150);
  const child = createObject(figure, 2, 300, 150, {
    join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1},
  });
  report.keyframes = [createFrame([parent, child], 10)];
  const native = engineEditor({demo: false}, report);
  native.select(1, 7);
  native.setNodeIK({enabled: true, pinned: true, bendDirection: 0});
  const endpoint = native.geometry.objects.get(native.selectedSlot).joints.get(8);
  native.poseJoint(endpoint.x - 40, endpoint.y - 30);
  const document = native.serialize();
  const next = structuredClone(document.keyframes[0]);
  delete next._styk;
  next.objects[0]._stykIK[8].target.x += 20;
  next.objects[1].angles[0] += .4;
  document.keyframes.push(next);
  const editor = engineEditor({demo: false, layerTimeline: true}, document);
  const layer = editor.createLayer('Attachment');
  editor.assignFiguresToLayer([2], layer.id);
  editor.sheetSetEasing([layer.id], 0, 10, {interpolation: 'auto'});
  editor.setLayerLocked('layer-1', true);
  editor.seek(5);
  editor.select(2, 0);
  return editor;
}

test('posing an eased attachment leaves its locked IK ancestor and keys unchanged', () => {
  const editor = fixture(), before = editor.serialize();
  const lockedTrack = editor.report._styk.layerSheet.tracks['layer-1'];
  const ancestor = structuredClone(editor.selectionFrame.objects.find(o => o.unique_id === 1));
  const geometry = editor.geometry.objects.get(editor.selectedSlot);
  editor.beginDrag('Pose attachment');
  editor.poseJoint(geometry.segments[0].end.x + 15, geometry.segments[0].end.y + 10);
  assert.deepEqual(editor.frame.objects.find(o => o.unique_id === 1), ancestor);
  assert.equal(editor.commitDrag(), true);
  assert.equal(editor._drag, null);
  assert.equal(editor._authoredPoseEdit, null);
  assert.equal(editor.report._styk.layerSheet.tracks['layer-1'], lockedTrack);
  assert.ok(editor.layerFrameKeys('layer-2').some(key => key.tick === 5));
  const after = editor.serialize();
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
  const reopened = engineEditor({demo: false, layerTimeline: true}, after);
  reopened.seek(5);
  assert.deepEqual(reopened.evaluatedFrame, editor.evaluatedFrame);
});

test('a rejected cross-layer pose clears the draft without publishing partial keys or history', () => {
  const editor = fixture();
  editor.setLayerLocked('layer-1', false);
  editor.setLayerLocked('layer-2', true);
  editor.select(1, 0);
  const before = editor.serialize(), history = editor._undo.length;
  editor.beginDrag('Rotate parent and locked attachment');
  editor.rotateJoint(.2);
  assert.throws(() => editor.commitDrag(), /Unlock Attachment/);
  assert.equal(editor._drag, null);
  assert.equal(editor._authoredPoseEdit, null);
  assert.equal(editor._undo.length, history);
  assert.deepEqual(editor.serialize(), before);
  assert.equal(editor.commitDrag(), false);
  editor.seek(7);
  editor.setLayerLocked('layer-2', false);
  editor.select(2, 0);
  editor.rotateJoint(.1);
  assert.equal(editor._drag, null);
  assert.doesNotThrow(() => new Editor({demo: false, layerTimeline: true}).load(editor.serialize()));
});
