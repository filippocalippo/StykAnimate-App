import test from 'node:test';
import assert from 'node:assert/strict';
import {joinTargetUids} from '../src/figure-join-action.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

function fixture({prepare = null} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1].map(() => createFrame([101, 707, 909].map((uid, slot) => createObject(figure, uid, 200 + slot * 180, 260))));
  prepare?.(report);
  const editor = open({demo: false}); editor.load(report); editor.select(707, 2); return editor;
}
test('joining excludes self and descendants by slots with sparse UIDs and bounded cycle traversal', () => {
  const objects = [101, 707, 909, 4].map(unique_id => ({unique_id}));
  objects[0].join = {target_object_slot: 2}; objects[1].join = {target_object_slot: 0};
  assert.deepEqual([...joinTargetUids({objects}, 101)], [909, 4]);
  objects[2].join = {target_object_slot: 1};
  assert.deepEqual([...joinTargetUids({objects}, 101)], [4]);
  assert.equal(joinTargetUids({objects}, 999).size, 0);
});
test('UI join route edits only the owning figure, preserves selection, and detaches without a jump', () => {
  const editor = fixture(), original = editor.geometry.objects.get(1).root;
  editor.joinFiguresInFrames(101, 3, undefined, {uids: [707], atPlayhead: true});
  const joined = {...editor.geometry.objects.get(1).root};
  assert.notDeepEqual(joined, original);
  assert.equal(editor.selectedJoint, 2);
  assert.equal(editor.object.join.target_handle_id, 3);
  editor.detachFiguresInFrames(undefined, {uids: [707], atPlayhead: true});
  assert.deepEqual(editor.geometry.objects.get(1).root, joined);
  assert.equal(editor.object.join, null);
  editor.undo(); assert.equal(editor.object.join.target_unique_id, 101);
  editor.undo(); assert.equal(editor.object.join, null); assert.deepEqual(editor.geometry.objects.get(1).root, original);
  editor.redo(); editor.redo(); assert.deepEqual(editor.geometry.objects.get(1).root, joined);
});
test('range joins are atomic, undoable, and history excludes unrelated pose payloads', () => {
  const editor = fixture({prepare: report => { for (const frame of report.keyframes) frame.objects[2]._unrelated = 'x'.repeat(500000); }});
  editor.joinFiguresInFrames(101, 3, [0, 1], {uids: [707]});
  assert.ok(editor.report.keyframes.every(frame => frame.objects[1].join?.target_unique_id === 101));
  assert.ok(editor._undo.at(-1).bytes < 12000);
  editor.undo(); assert.ok(editor.report.keyframes.every(frame => !frame.objects[1].join));
  const cyclic = fixture({prepare: report => { report.keyframes[1].objects[0].join = {target_object_slot: 1, target_unique_id: 707, target_handle_id: 3}; }});
  const before = JSON.stringify(cyclic.report);
  assert.throws(() => cyclic.joinFiguresInFrames(101, 3, [0, 1], {uids: [707]}), /cycle|cyclic/i);
  assert.equal(JSON.stringify(cyclic.report), before);
});
