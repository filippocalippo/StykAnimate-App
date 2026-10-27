import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {geometryOfFrame} from './support/engine-geometry.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();
const clone = value => structuredClone(value), near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
/** `prepare` changes the document before it opens; `sheet`: the document has a layer sheet. */
function fixture({prepare = null, sheet = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1, 2].map(index => createFrame([createObject(figure, 1, 100 + index * 20, 180), createObject(figure, 2, 260, 180), createObject(figure, 3, 420, 180)], 5));
  prepare?.(report);
  const editor = open({demo: false, ...(sheet ? {layerTimeline: true, propertyChannels: true} : {})}, report); editor.select(1); return editor;
}

test('appearance range follows native identity through arbitrary slots and absent figures with one sparse undo', () => {
  const editor = fixture(); let report = editor.report; report.keyframes[1].objects.reverse();
  report.keyframes[1].objects.forEach((object, slot) => object.object_slot = slot);
  report.keyframes[2] = createFrame([report.keyframes[2].objects[1]], 1); editor.load(report); report = editor.report;
  editor.select(1); const before = clone(report), unchanged = report.keyframes[0].objects[1];
  const result = editor.updateFiguresInFrames({color_override_raw: 0xff224466, field28: 80}, [0, 1, 2]);
  assert.equal(result.changedFrames, 2); assert.equal(editor._undo.length, 1); assert.equal(report.keyframes[0].objects[1], unchanged);
  for (const index of [0, 1]) assert.equal(report.keyframes[index].objects.find(object => object.unique_id === 1).field28, 80);
  assert.ok(editor._undo[0].bytes < 4000); assert.ok(!JSON.stringify(editor._undo[0]).includes('angles'));
  editor.undo(); assert.deepEqual(report, before); editor.redo(); assert.equal(report.keyframes[1].objects.find(object => object.unique_id === 1).field28, 80);
});
test('later-frame invalid join rejects the complete range before changing identities or history', () => {
  const editor = fixture(), other = clone(editor.report.figure_types[0]); other.figure_type_id = 2; other.segments[0].segment_id = 50;
  for (const segment of other.segments) if (segment.parent_id === 1) segment.parent_id = 50;
  editor.report.figure_types.push(other); editor.report.keyframes[2].objects[1].figure_type_id = 2; editor.load(editor.report); editor.select(1);
  const before = clone(editor.report), identity = editor._nextUid;
  assert.throws(() => editor.joinFiguresInFrames(2, 1, [0, 2]), /joint/); assert.deepEqual(editor.report, before); assert.equal(editor._nextUid, identity); assert.equal(editor.canUndo, false);
  editor.joinFiguresInFrames(2, 50, [2]); assert.equal(editor.report.keyframes[2].objects[0].join.target_handle_id, 50);
  editor.detachFiguresInFrames([2]); assert.equal(editor.report.keyframes[2].objects[0].join, null);
});

test('authored add and delete range target composed tick presence with stable identities and one undo', () => {
  const editor = fixture({sheet: true}), native = clone(editor.report.keyframes);
  const added = editor.addFigureInFrames(1, undefined, {ticks: [2, 8], x: 20, y: 30}), uid = added.insertedUids[0];
  assert.equal(editor._undo.length, 1); assert.deepEqual(editor.report.keyframes, native);
  for (const tick of [2, 8]) { editor.seek(tick); editor.select(uid); assert.equal(editor.object.unique_id, uid); near(editor.object.root_x, 20); }
  editor.deleteFiguresInFrames(undefined, {ticks: [3, 9], uids: [uid]});
  assert.equal(editor._undo.length, 2);
  for (const tick of [3, 9]) { editor.seek(tick); assert.equal(editor.selectionFrame.objects.some(object => object.unique_id === uid), false); }
  editor.undo(); editor.seek(3); assert.equal(editor.selectionFrame.objects.some(object => object.unique_id === uid), true);
  editor.redo(); editor.seek(9); assert.equal(editor.selectionFrame.objects.some(object => object.unique_id === uid), false);
  assert.deepEqual(editor.report.keyframes, native); assert.doesNotThrow(() => new Editor({demo: false}).load(editor.serialize()));
});

test('duplicate capacity and overflow fail atomically without consuming identities or replacing clipboard', () => {
  const editor = fixture({sheet: true}); editor.select(1); editor.copySelection(); const before = clone(editor.report), clipboard = editor._selectionClipboard, uid = editor._nextUid;
  assert.throws(() => editor.duplicateInFrames([0, 2], {offset: Number.MAX_VALUE}), /finite|native/);
  assert.deepEqual(editor.report, before); assert.equal(editor._selectionClipboard, clipboard); assert.equal(editor._nextUid, uid); assert.equal(editor.canUndo, false);
});

for (const operation of ['rotate', 'center']) test(`${operation} range matches each frame's individual command with joined component semantics`, () => {
  const editor = fixture();
  for (const [index, frame] of editor.report.keyframes.entries()) {
    frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
    frame.objects[1].angles[1] += index * .3; frame.objects[2].root_y += index * 50;
  }
  editor.load(editor.report); editor.selectMany([2, 3]); const original = clone(editor.report), expected = [];
  for (let index = 0; index < 3; index++) {
    const single = open({demo: false}, clone(original)); single.selectFrame(index); single.selectMany([2, 3]);
    if (operation === 'rotate') single.rotateSelection(.3);
    else single.centerFigure();
    expected.push(single.geometry);
  }
  const result = operation === 'rotate' ? editor.rotateFiguresInFrames(.3, [0, 1, 2]) : editor.centerFiguresInFrames([0, 1, 2]);
  assert.equal(result.changedFrames, 3); assert.equal(editor._undo.length, 1);
  for (let index = 0; index < 3; index++) {
    const actual = geometryOfFrame(editor, editor.report.keyframes[index]);
    for (const [slot, g] of expected[index].objects) {
      const next = actual.objects.get(slot); assert.ok(Math.abs(g.root.x - next.root.x) < .0001); assert.ok(Math.abs(g.root.y - next.root.y) < .0001);
      g.segments.forEach((segment, i) => { assert.ok(Math.abs(segment.end.x - next.segments[i].end.x) < .0001); assert.ok(Math.abs(segment.end.y - next.segments[i].end.y) < .0001); });
    }
  }
  editor.undo(); assert.deepEqual(editor.report, original); editor.redo(); assert.doesNotThrow(() => editor.serialize());
});

test('range pose reset uses each current definition and leaves unselected attached poses, appearance and origins intact', () => {
  const editor = fixture(), figure = editor.report.figure_types[0], custom = clone(figure); custom.figure_type_id = 2; custom.segments[0].angle_rad += .4;
  editor.report.figure_types.push(custom);
  for (const [index, frame] of editor.report.keyframes.entries()) {
    frame.objects[0].figure_type_id = index === 2 ? 2 : 1; frame.objects[0].angles[0] += .9;
    frame.objects[0].len_flag = frame.objects[0].bend_flag = 1;
    frame.objects[0].lengths = figure.segments.map(segment => segment.length * 1.2); frame.objects[0].bends = figure.segments.map(() => .1);
    frame.objects[0].color_override_raw = 0xff2255aa; frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
  }
  editor.load(editor.report); editor.select(1); const before = clone(editor.report), result = editor.resetPoseInFrames([0, 2]);
  assert.equal(result.changedFrames, 2); assert.equal(editor._undo.length, 1);
  for (const index of [0, 2]) {
    const [parent, child] = editor.report.keyframes[index].objects;
    assert.deepEqual(parent.angles, (index === 2 ? custom : figure).segments.map(segment => segment.angle_rad));
    assert.equal(parent.len_flag, 0); assert.equal(parent.bend_flag, 0); assert.deepEqual(parent.lengths, []);
    assert.deepEqual(child.angles, before.keyframes[index].objects[1].angles); assert.equal(parent.color_override_raw, 0xff2255aa);
    assert.equal(parent.root_x, before.keyframes[index].objects[0].root_x);
    const geometry = geometryOfFrame(editor, editor.report.keyframes[index]); assert.equal(child.root_x, geometry.objects.get(1).root.x);
  }
  assert.deepEqual(editor.report.keyframes[1], before.keyframes[1]); editor.undo(); assert.deepEqual(editor.report, before); editor.redo();
  assert.equal(editor.resetPoseInFrames([0, 2]).changedFrames, 0);
});

