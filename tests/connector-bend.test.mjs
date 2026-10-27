import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {rigExampleDocument} from '../src/rig-examples.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

// Sliding carriage: segment index 2 is a connector from (200, 230) to (440, 230) sliding at 50%.
function fixture(owned = true) {
  const doc = rigExampleDocument('sliding-carriage');
  const editor = owned ? ownedEditorFor({demo: false}, doc) : new Editor({demo: false}).load(doc);
  editor.select(1, 2); return editor;
}
const rail = editor => [...editor.geometry.objects.values()][0].segments[2];
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('bending a connector keeps the slide position and does not rotate attached parts twice', () => {
  const editor = fixture(), object = structuredClone(editor.object);
  const carriage = e => [...e.geometry.objects.values()][0].segments.find(s => s.seg.parent_id === e.figure.segments[2].segment_id);
  const restAngle = carriage(editor).angle, restRail = rail(editor).angle;
  editor.beginDrag('Pose joint');
  editor.bendJoint(320, 210, {stretch: true});
  editor.commitDrag();
  const after = editor.object;
  assert.deepEqual(after.angles, object.angles, 'no joint angle is rewritten');
  assert.equal(after.len_flag ? after.lengths[2] : editor.figure.segments[2].length, .5);
  // Attached parts inherit the connector's rotation once, as when sliding along a curved rail.
  near(carriage(editor).angle - restAngle, rail(editor).angle - restRail, 1e-9);
  near(carriage(editor).start.x, rail(editor).handle.x, 1e-9);
  near(carriage(editor).start.y, rail(editor).handle.y, 1e-9);
});

test('Build rig bend on a connector publishes one reusable definition edit', () => {
  const editor = fixture(), history = editor._undo.length;
  assert.ok(editor.beginRigDrag({bend: true}));
  editor.bendJoint(320, 215);
  editor.commitRigDrag?.() ?? editor.commitDrag();
  assert.equal(editor._undo.length, history + 1);
  assert.ok(editor.figure.segments[2].bend_rad > 0);
  near(rail(editor).handle.y, 215, 1e-6);
  editor.undo();
  assert.equal(editor.figure.segments[2].bend_rad ?? 0, 0);
});
