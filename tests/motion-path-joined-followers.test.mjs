import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownedEditorFor} from './support/owned-editor.mjs';
const document = () => JSON.parse(readFileSync(new URL('../engine/crates/styk-eval/tests/fixtures/ik/joined.json', import.meta.url), 'utf8'));
const target = {kind: 'node', uid: 3, handleId: 33, joint: 0};
const bytes = editor => JSON.stringify(editor.report);
test('joined pinned follower trail rotates without changing selection or publishing before commit', () => {
  const editor = ownedEditorFor({demo: false, layerTimeline: true}, document());
  // The limb the trail grabs, in the pose the document gives at the grabbed tick.
  editor.seek(2); const shape = editor.geometry.objects.get(2).segments[0];
  editor.seek(5); editor.select(3, 0);
  const saved = bytes(editor), history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit(target, 2));
  const point = {x: shape.start.x + (shape.end.x - shape.start.x) * Math.cos(.25) - (shape.end.y - shape.start.y) * Math.sin(.25),
    y: shape.start.y + (shape.end.x - shape.start.x) * Math.sin(.25) + (shape.end.y - shape.start.y) * Math.cos(.25)};
  assert.equal(editor.updateMotionPathEdit(point), true);
  assert.equal(bytes(editor), saved); assert.equal(editor.tick, 5); assert.equal(editor.selectedUid, 3); assert.equal(editor.selectedJoint, 0);
  assert.equal(editor.cancelMotionPathEdit(), true); assert.equal(bytes(editor), saved); assert.equal(editor._undo.length, history);
  assert.ok(editor.beginMotionPathEdit(target, 2)); assert.equal(editor.updateMotionPathEdit(point), true);
  assert.equal(editor.commitMotionPathEdit(), true); const committed = bytes(editor); assert.notEqual(committed, saved);
  editor.undo(); assert.equal(bytes(editor), saved); editor.redo(); assert.equal(bytes(editor), committed);
});
