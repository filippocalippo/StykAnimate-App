import test from 'node:test';
import assert from 'node:assert/strict';
import {validateScene} from '../src/pivot/model.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1e-3, `${label}: ${a} != ${b}`);
const index = (editor, name) => editor.figure.segments.findIndex(segment => segment.name === name);
const blue = layerTimeline => ownedEditorFor({layerTimeline}).newDocument();

/** Every drawable's points, keyed by figure family (a source and its disconnected
 * part share one), primitive and native handle, which disconnecting preserves. */
function picture(editor, family = uid => uid) {
  const result = new Map();
  for (const drawable of editor.geometry.drawables) {
    const id = drawable.type === 'poly'
      ? `poly:${Math.round(drawable.points.reduce((sum, p) => sum + p.x, 0))}:${Math.round(drawable.points.reduce((sum, p) => sum + p.y, 0))}`
      : `${drawable.type}:${drawable.seg.segment_id}`;
    result.set(`${family(drawable.obj.unique_id)}:${id}`, drawable.points);
  }
  return result;
}
function samePicture(before, after, label) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), label);
  for (const [key, points] of before) {
    const other = after.get(key); assert.equal(other.length, points.length, `${label} ${key}`);
    points.forEach((point, i) => { near(other[i].x, point.x, `${label} ${key} x`); near(other[i].y, point.y, `${label} ${key} y`); });
  }
}
/** Three held poses: Blue walks right while its left arm swings. */
function animated(editor) {
  for (const tick of [4, 8]) editor.sheetInsertKey(['layer-1'], tick);
  const keys = [0, 4, 8];
  keys.forEach((key, i) => {
    editor.seek(key);
    editor.select(1); editor.updateObject({root_x: editor.object.root_x + 30 * i});
    editor.select(1, index(editor, 'Left upper arm')); editor.rotateJoint(0.4 * i);
    editor.select(1, index(editor, 'Left forearm')); editor.rotateJoint(-0.3 * i);
  });
  return keys;
}
const visit = (editor, key) => editor.seek(key);

test('disconnect turns a branch into an unjoined figure in every frame without moving its drawing', () => {
  const editor = blue(true), keys = animated(editor);
  const pictures = keys.map(key => { visit(editor, key); return picture(editor); });
  visit(editor, keys[1]); editor.select(1, index(editor, 'Left upper arm'));
  const saved = editor.serialize(), depth = editor._undo.length;
  assert.equal(editor.canDisconnectSegment(), true);
  const piece = editor.disconnectSegment(), uid = piece.unique_id, family = id => id === uid ? 1 : id;
  assert.equal(editor._undo.length, depth + 1, 'one undo step');
  assert.equal(editor.selectedUid, uid); assert.equal(piece.join, null);
  assert.equal(editor.figure.name, 'Left upper arm');
  assert.deepEqual(editor.figure.segments.map(s => [s.segment_id, s.parent_id]), [[3, 0], [4, 3]]);
  const source = editor.report.figure_types.find(figure => figure.figure_type_id === editor.selectionFrame.objects.find(o => o.unique_id === 1).figure_type_id);
  assert.deepEqual(source.segments.map(s => s.segment_id), [1, 2, 5, 6, 7, 8, 9, 10]);
  assert.equal(editor.report.figure_types.length, 2, 'an unshared definition is trimmed, not copied');
  assert.equal(editor.layerForUid(uid), editor.layerForUid(1));
  // The hand controller (chain of two) lies inside the part and moves with it.
  assert.deepEqual(Object.keys(piece._stykIK), ['4']); assert.equal(piece._stykIK[4].chainLength, 2);
  assert.equal(editor.selectionFrame.objects.find(o => o.unique_id === 1)._stykIK[4], undefined);
  keys.forEach((key, i) => { visit(editor, key); samePicture(pictures[i], picture(editor, family), `key ${key}`); });
  assert.doesNotThrow(() => validateScene(editor.serialize()));
  const reopened = ownedEditorFor({layerTimeline: true}, editor.serialize());
  keys.forEach((key, i) => { visit(reopened, key); samePicture(pictures[i], picture(reopened, family), `reopened ${key}`); });
  editor.undo(); assert.deepEqual(editor.serialize(), saved, 'undo restores the document exactly');
  editor.redo(); visit(editor, keys[2]); samePicture(pictures[2], picture(editor, family), 'redo');
  assert.equal(editor.layerForUid(uid), editor.layerForUid(1));
});

test('linked instances keep the whole rig; only the selected instance splits', () => {
  const editor = blue(true); editor.addFigure(editor.figure.figure_type_id);
  const other = editor.selectedUid, typeId = editor.figure.figure_type_id, before = picture(editor), saved = editor.serialize();
  editor.select(1, index(editor, 'Right forearm'));
  const uid = editor.disconnectSegment().unique_id, objects = new Map(editor.selectionFrame.objects.map(o => [o.unique_id, o]));
  assert.equal(objects.get(other).figure_type_id, typeId);
  assert.equal(editor.report.figure_types.find(f => f.figure_type_id === typeId).segments.length, 10);
  const source = editor.report.figure_types.find(f => f.figure_type_id === objects.get(1).figure_type_id);
  assert.notEqual(source.figure_type_id, typeId); assert.equal(source.segments.length, 9);
  assert.equal(editor.report.figure_types.length, 3);
  samePicture(before, picture(editor, id => id === uid ? 1 : id), 'linked');
  editor.undo(); assert.deepEqual(editor.serialize(), saved);
});

test('figures joined to the part stay on the same joint of the new figure', () => {
  for (const layerTimeline of [true, false]) {
    const editor = blue(layerTimeline);
    editor.addFigure(editor.figure.figure_type_id); const hand = editor.selectedUid; editor.joinTo(1, 4);
    editor.addFigure(editor.figure.figure_type_id); const chest = editor.selectedUid; editor.joinTo(1, 1);
    const before = picture(editor);
    editor.select(1, index(editor, 'Left upper arm'));
    const uid = editor.disconnectSegment().unique_id, objects = new Map(editor.selectionFrame.objects.map(o => [o.unique_id, o]));
    assert.equal(objects.get(hand).join.target_unique_id, uid); assert.equal(objects.get(hand).join.target_handle_id, 4);
    assert.equal(objects.get(chest).join.target_unique_id, 1); assert.equal(objects.get(chest).join.target_handle_id, 1);
    samePicture(before, picture(editor, id => id === uid ? 1 : id), 'joined children');
  }
});

test('a joined source and a pinned IK chain keep their displayed pose', () => {
  const editor = blue(true); editor.addFigure(editor.figure.figure_type_id); const parent = editor.selectedUid;
  editor.select(1); editor.joinTo(parent, 2);
  editor.select(1, index(editor, 'Left forearm')); editor.setNodeIK({pinned: true});
  editor.select(parent); editor.updateObject({root_x: editor.object.root_x - 25});
  const before = picture(editor);
  editor.select(1, index(editor, 'Left forearm'));
  const uid = editor.disconnectSegment().unique_id, family = id => id === uid ? 1 : id;
  samePicture(before, picture(editor, family), 'pinned IK');
  assert.equal(editor.object._stykIK[4].chainLength, 1, 'the chain is shortened to the part');
});

test('fills move with their part; a fill across the cut is refused without changes', () => {
  const editor = blue(true);
  editor.addPolygon([1, 3, 4]); editor.addPolygon([0, 7, 9]);
  const before = picture(editor);
  editor.select(1, index(editor, 'Left upper arm'));
  const piece = editor.disconnectSegment(), uid = piece.unique_id;
  assert.deepEqual(editor.figure.polyfills.map(p => p.segment_ids), [[0, 3, 4]]);
  const source = editor.report.figure_types.find(f => f.figure_type_id === editor.selectionFrame.objects.find(o => o.unique_id === 1).figure_type_id);
  assert.deepEqual(source.polyfills.map(p => p.segment_ids), [[0, 7, 9]]);
  samePicture(before, picture(editor, id => id === uid ? 1 : id), 'fills');

  const spanning = blue(true); spanning.addPolygon([2, 3, 4]);
  const saved = spanning.serialize(), depth = spanning._undo.length;
  spanning.select(1, index(spanning, 'Left upper arm'));
  assert.throws(() => spanning.disconnectSegment(), /fill/i);
  assert.deepEqual(spanning.serialize(), saved); assert.equal(spanning._undo.length, depth);
});

test('the whole figure, an origin or a locked layer cannot be disconnected', () => {
  const editor = blue(true);
  editor.select(1); assert.equal(editor.canDisconnectSegment(), false);
  editor.select(1, index(editor, 'Left upper arm')); editor.disconnectSegment();
  editor.select(editor.selectedUid, 0); assert.equal(editor.canDisconnectSegment(), false, 'the part is now a whole figure');
  assert.throws(() => editor.disconnectSegment(), /part of a figure/);
  editor.select(1); editor.select(1, index(editor, 'Head')); editor.setLayerLocked(editor.layerForUid(1), true);
  const saved = editor.serialize();
  assert.throws(() => editor.disconnectSegment(), /Unlock/); assert.deepEqual(editor.serialize(), saved);
});
