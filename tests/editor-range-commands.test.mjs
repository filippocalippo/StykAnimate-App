import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
const clone = value => structuredClone(value), near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1, 2].map(index => createFrame([createObject(figure, 1, 100 + index * 20, 180), createObject(figure, 2, 260, 180), createObject(figure, 3, 420, 180)], 5));
  const editor = new Editor({demo: false}).load(report); editor.select(1); return editor;
}
test('appearance range follows native identity through arbitrary slots and absent figures with one sparse undo', () => {
  const editor = fixture(), report = editor.report; report.keyframes[1].objects.reverse();
  report.keyframes[1].objects.forEach((object, slot) => object.object_slot = slot);
  report.keyframes[2] = createFrame([report.keyframes[2].objects[1]], 1); editor.load(report);
  editor.select(1); const before = clone(report), unchanged = report.keyframes[0].objects[1];
  const result = editor.updateFiguresInFrames({color_override_raw: 0xff224466, field28: 80}, [0, 1, 2]);
  assert.equal(result.changedFrames, 2); assert.equal(editor._undo.length, 1); assert.equal(report.keyframes[0].objects[1], unchanged);
  for (const index of [0, 1]) assert.equal(report.keyframes[index].objects.find(object => object.unique_id === 1).field28, 80);
  assert.ok(editor._undo[0].bytes < 4000); assert.ok(!JSON.stringify(editor._undo[0]).includes('angles'));
  editor.undo(); assert.deepEqual(report, before); editor.redo(); assert.equal(report.keyframes[1].objects.find(object => object.unique_id === 1).field28, 80);
});
test('add uses one fresh UID across selected frames and active layer membership survives undo', () => {
  const editor = fixture(), layer = editor.createLayer('Foreground'), before = clone(editor.report), count = editor._undo.length;
  const result = editor.addFigureInFrames(1, [0, 2], {x: 17, y: 29});
  assert.equal(result.insertedUids.length, 1); const uid = result.insertedUids[0]; assert.equal(editor.layerForUid(uid), layer.id);
  assert.equal(editor._undo.length, count + 1); for (const i of [0, 2]) near(editor.report.keyframes[i].objects.find(o => o.unique_id === uid).root_x, 17);
  assert.equal(editor.report.keyframes[1].objects.length, 3); editor.undo(); assert.deepEqual(editor.report, before); editor.redo(); assert.equal(editor.layerForUid(uid), layer.id);
});
test('paste remaps clipboard definitions once and internal joins by fresh UID consistently across frames', () => {
  const source = fixture(); source.select(2); source.joinTo(1, 1); source.selectMany([1, 2]); source.copySelection();
  const editor = fixture(); editor._selectionClipboard = source._selectionClipboard;
  const before = clone(editor.report), types = before.figure_types.length, result = editor.pasteFiguresInFrames([0, 1]);
  assert.equal(result.insertedUids.length, 2); assert.equal(editor.report.figure_types.length, types + 1);
  for (const i of [0, 1]) {
    const frame = editor.report.keyframes[i], joined = frame.objects.find(object => object.unique_id === result.insertedUids[1]);
    assert.equal(frame.objects[joined.join.target_object_slot].unique_id, result.insertedUids[0]);
    near(frame.objects.find(object => object.unique_id === result.insertedUids[0]).root_x, 100);
  }
  editor.undo(); assert.deepEqual(editor.report, before); editor.redo(); assert.equal(editor.report.figure_types.length, types + 1);
});
test('deleting across frames detaches surviving joined children at their visible positions and patches slots sparsely', () => {
  const editor = fixture(); for (const frame of editor.report.keyframes) frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
  editor.load(editor.report); editor.select(1); const before = clone(editor.report), roots = editor.report.keyframes.map(frame => buildGeometry(editor.report, frame).objects.get(1).root);
  const result = editor.deleteFiguresInFrames([0, 2]); assert.equal(result.changedFrames, 2);
  for (const index of [0, 2]) { const child = editor.report.keyframes[index].objects[0]; assert.equal(child.unique_id, 2); assert.equal(child.join, null); near(child.root_x, roots[index].x); }
  assert.equal(editor.report.keyframes[1].objects.length, 3); editor.undo(); assert.deepEqual(editor.report, before); editor.redo(); assert.doesNotThrow(() => editor.serialize());
});
test('order stays inside assigned layers and records only paint-order arrays', () => {
  const editor = fixture(), layer = editor.createLayer('Top'); editor.assignFiguresToLayer([2], layer.id); editor.select(1);
  const before = clone(editor.report), result = editor.orderFiguresInFrames('front', [0, 1]); assert.equal(result.changedFrames, 2);
  assert.deepEqual(editor.report.keyframes[0].object_draw_order_unique_ids, [3, 2, 1]);
  assert.ok(editor._undo.at(-1).changes.every(change => !change.patches.length)); editor.undo(); assert.deepEqual(editor.report, before);
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
test('absolute range scale preserves selected proportions and mirror affects joined descendants only once', () => {
  const editor = fixture(); editor.report.keyframes[0].objects[1].scale = 2; editor.selectMany([2, 1]);
  editor.scaleFiguresInFrames(3, [0]); near(editor.report.keyframes[0].objects[0].scale, 3); near(editor.report.keyframes[0].objects[1].scale, 6);
  editor.undo(); editor.select(2); editor.joinTo(1, 1); editor.selectMany([1, 2]); const before = clone(editor.report), angle = editor.report.keyframes[0].objects[1].angles[0];
  editor.mirrorFiguresInFrames('vertical', [0, 2]); near(editor.report.keyframes[0].objects[1].angles[0], -angle); editor.undo(); assert.deepEqual(editor.report, before);
});
test('authored explicit ticks edit composed presence and leave all native frames unchanged', () => {
  const editor = fixture(); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.select(1); const native = clone(editor.report.keyframes), count = editor._undo.length;
  const result = editor.updateFiguresInFrames({color_override_raw: 0xff778899}, undefined, {ticks: [2, 7]});
  assert.deepEqual(result.changedTicks, [2, 7]); assert.equal(editor._undo.length, count + 1); assert.deepEqual(editor.report.keyframes, native);
  for (const tick of [2, 7]) { editor.seek(tick); assert.equal(editor.object.color_override_raw, 0xff778899); }
  editor.undo(); editor.seek(7); assert.equal(editor.object.color_override_raw, 0); editor.redo(); editor.seek(2); assert.equal(editor.object.color_override_raw, 0xff778899);
  assert.doesNotThrow(() => new Editor({demo: false}).load(editor.serialize()));
});
test('authored opacity and numeric scale ranges use sparse scalar keys without pose snapshots', () => {
  const editor = fixture(); editor.addAnimationKey({kind: 'figure', uid: 1}, 'x', 0, 150); editor.select(1);
  const native = clone(editor.report.keyframes); editor.updateFiguresInFrames({opacity: .4}, undefined, {ticks: [2, 8]});
  editor.scaleFiguresInFrames(2, undefined, {ticks: [2, 8]}); assert.equal(editor.report._styk.frameSources, undefined);
  for (const tick of [2, 8]) { editor.seek(tick); near(editor.object.scale, 2); assert.equal(editor.object.field28, 153); near(editor.object.root_x, 150); }
  assert.deepEqual(editor.report.keyframes, native); editor.undo(); editor.seek(2); near(editor.object.scale, 1); editor.redo(); editor.seek(2); near(editor.object.scale, 2);
});

test('authored range scaling leaves unselected attached scale channels free to animate', () => {
  const editor = fixture();
  for (const frame of editor.report.keyframes) frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
  editor.load(editor.report); editor.addAnimationKey({kind: 'figure', uid: 2}, 'scale', 0, 1);
  editor.addAnimationKey({kind: 'figure', uid: 2}, 'scale', 10, 3);
  const channel = structuredClone(editor.animationChannels.find(channel => channel.target.uid === 2));
  editor.select(1); editor.scaleFiguresInFrames(2, undefined, {ticks: [3, 7]});
  assert.deepEqual(editor.animationChannels.find(channel => channel.target.uid === 2), channel);
  for (const tick of [3, 7]) { editor.seek(tick); near(editor.object.scale, 2); }
  assert.equal(editor.report._styk.frameSources, undefined);
});

test('authored add and delete range target composed tick presence with stable identities and one undo', () => {
  const editor = fixture(), native = clone(editor.report.keyframes);
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

test('range duplication preserves each source pose, internal joins and clipboard with one consistent UID mapping', () => {
  const editor = fixture();
  for (const [index, frame] of editor.report.keyframes.entries()) {
    frame.objects[0].angles[0] += index * .4;
    frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
    frame.objects[1].angles[0] -= index * .25;
  }
  editor.load(editor.report); editor.select(3); editor.copySelection(); const clipboard = editor._selectionClipboard;
  editor.selectMany([1, 2]); const before = clone(editor.report), geometry = before.keyframes.map(frame => buildGeometry(before, frame));
  const result = editor.duplicateInFrames([0, 1, 2]), [parent, child] = result.insertedUids;
  assert.equal(editor._selectionClipboard, clipboard); assert.equal(editor._undo.length, 1); assert.equal(result.changedFrames, 3);
  for (const [index, frame] of editor.report.keyframes.entries()) {
    const a = frame.objects.find(object => object.unique_id === parent), b = frame.objects.find(object => object.unique_id === child);
    assert.deepEqual(a.angles, before.keyframes[index].objects[0].angles); assert.deepEqual(b.angles, before.keyframes[index].objects[1].angles);
    near(a.root_x, before.keyframes[index].objects[0].root_x + 24); assert.equal(frame.objects[b.join.target_object_slot].unique_id, parent);
    const copied = buildGeometry(editor.report, frame).objects.get(b.object_slot);
    assert.ok(Math.abs(copied.root.x - geometry[index].objects.get(1).root.x - 24) < .0001);
    assert.equal(b.root_x, copied.root.x); assert.equal(b.root_y, copied.root.y);
  }
  editor.undo(); assert.deepEqual(editor.report, before); editor.redo(); assert.equal(editor.report.keyframes[2].objects.length, 5);
});

test('range duplication skips absent identities, preserves layer membership and detaches external parents in world coordinates', () => {
  const editor = fixture(); for (const frame of editor.report.keyframes) frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
  editor.report.keyframes[1] = createFrame([editor.report.keyframes[1].objects[0]], 5); editor.load(editor.report);
  const layer = editor.createLayer('Copies'); editor.assignFiguresToLayer([2], layer.id); editor.select(2);
  const root = buildGeometry(editor.report, editor.report.keyframes[0]).objects.get(1).root;
  const result = editor.duplicateInFrames([0, 1, 2], {offset: 0}), uid = result.insertedUids[0]; assert.equal(result.changedFrames, 2);
  assert.equal(editor.layerForUid(uid), layer.id); assert.equal(editor.report.keyframes[1].objects.length, 1);
  const copied = editor.report.keyframes[0].objects.find(object => object.unique_id === uid); assert.equal(copied.join, null); near(copied.root_x, root.x); near(copied.root_y, root.y);
});

test('authored duplicate ranges sample each composed tick without changing native frames or source scalar curves', () => {
  const editor = fixture(); editor.addAnimationKey({kind: 'figure', uid: 1}, 'x', 0, 100); editor.addAnimationKey({kind: 'figure', uid: 1}, 'x', 10, 300);
  editor.select(1); const native = clone(editor.report.keyframes), curves = clone(editor.animationChannels);
  const result = editor.duplicateInFrames(undefined, {ticks: [2, 8], offset: 0}), uid = result.insertedUids[0];
  for (const tick of [2, 8]) { editor.seek(tick); const objects = new Map(editor.selectionFrame.objects.map(object => [object.unique_id, object])); near(objects.get(uid).root_x, objects.get(1).root_x); }
  assert.deepEqual(editor.report.keyframes, native); assert.deepEqual(editor.animationChannels.filter(channel => channel.property !== 'pose'), curves);
  editor.undo(); assert.deepEqual(editor.animationChannels, curves); editor.redo(); editor.seek(8); editor.select(uid); near(editor.object.root_x, 260);
});

test('duplicate capacity and overflow fail atomically without consuming identities or replacing clipboard', () => {
  const editor = fixture(); editor.select(1); editor.copySelection(); const before = clone(editor.report), clipboard = editor._selectionClipboard, uid = editor._nextUid;
  assert.throws(() => editor.duplicateInFrames([0, 2], {offset: Number.MAX_VALUE}), /finite|native/);
  assert.deepEqual(editor.report, before); assert.equal(editor._selectionClipboard, clipboard); assert.equal(editor._nextUid, uid); assert.equal(editor.canUndo, false);
});

for (const operation of ['rotate', 'align', 'center']) test(`${operation} range matches each frame's individual command with joined component semantics`, () => {
  const editor = fixture();
  for (const [index, frame] of editor.report.keyframes.entries()) {
    frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1};
    frame.objects[1].angles[1] += index * .3; frame.objects[2].root_y += index * 50;
  }
  editor.load(editor.report); editor.selectMany([2, 3]); const original = clone(editor.report), expected = [];
  for (let index = 0; index < 3; index++) {
    const single = new Editor({demo: false}).load(clone(original)); single.selectFrame(index); single.selectMany([2, 3]);
    if (operation === 'rotate') single.rotateSelection(.3);
    else if (operation === 'align') single.alignSelection('x', 'start');
    else single.centerFigure();
    expected.push(single.geometry);
  }
  const result = operation === 'rotate' ? editor.rotateFiguresInFrames(.3, [0, 1, 2]) : operation === 'align' ? editor.alignFiguresInFrames('x', 'start', [0, 1, 2]) : editor.centerFiguresInFrames([0, 1, 2]);
  assert.equal(result.changedFrames, 3); assert.equal(editor._undo.length, 1);
  for (let index = 0; index < 3; index++) {
    const actual = buildGeometry(editor.report, editor.report.keyframes[index]);
    for (const [slot, g] of expected[index].objects) {
      const next = actual.objects.get(slot); assert.ok(Math.abs(g.root.x - next.root.x) < .0001); assert.ok(Math.abs(g.root.y - next.root.y) < .0001);
      g.segments.forEach((segment, i) => { assert.ok(Math.abs(segment.end.x - next.segments[i].end.x) < .0001); assert.ok(Math.abs(segment.end.y - next.segments[i].end.y) < .0001); });
    }
  }
  editor.undo(); assert.deepEqual(editor.report, original); editor.redo(); assert.doesNotThrow(() => editor.serialize());
});

test('range alignment rejects a later invalid bound atomically and attached selections from one component create no edit', () => {
  const editor = fixture(); editor.selectMany([1, 2]); const before = clone(editor.report);
  assert.throws(() => editor.alignFiguresInFrames('x', 'start', [0, 2], {boundsOf: g => ({minX: g.obj.root_x === 140 ? NaN : g.root.x, minY: g.root.y, maxX: g.root.x + 10, maxY: g.root.y + 10})}), /bounds/);
  assert.deepEqual(editor.report, before); assert.equal(editor.canUndo, false);
  editor.report.keyframes.forEach(frame => { frame.objects[1].join = {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1}; });
  editor.load(editor.report); editor.selectMany([1, 2]); assert.equal(editor.alignFiguresInFrames('x', 'start', [0, 1]).changedFrames, 0);
  assert.equal(editor.rotateFiguresInFrames(0, [0, 1]).changedFrames, 0); assert.equal(editor.canUndo, false);
});

test('authored range rotation and centering preserve each composed pose and matching scalar overrides', () => {
  const editor = fixture(); editor.addAnimationKey({kind: 'figure', uid: 1}, 'x', 0, 100); editor.addAnimationKey({kind: 'figure', uid: 1}, 'x', 10, 300);
  editor.select(1); const native = clone(editor.report.keyframes), angle = editor.object.angles[0];
  editor.rotateFiguresInFrames(.25, undefined, {ticks: [2, 8]});
  for (const tick of [2, 8]) { editor.seek(tick); near(editor.object.angles[0], angle + .25); }
  editor.centerFiguresInFrames(undefined, {ticks: [2, 8]});
  for (const tick of [2, 8]) { editor.seek(tick); near(editor.object.root_x, editor.report.canvas_width / 2); near(editor.object.root_y, editor.report.canvas_height / 2); }
  assert.deepEqual(editor.report.keyframes, native); editor.undo(); editor.seek(8); near(editor.object.root_x, 260);
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
    const geometry = buildGeometry(editor.report, editor.report.keyframes[index]); assert.equal(child.root_x, geometry.objects.get(1).root.x);
  }
  assert.deepEqual(editor.report.keyframes[1], before.keyframes[1]); editor.undo(); assert.deepEqual(editor.report, before); editor.redo();
  assert.equal(editor.resetPoseInFrames([0, 2]).changedFrames, 0);
});

test('authored pose reset updates masking rotation keys at selected ticks without changing imported sources', () => {
  const editor = fixture(); editor.addAnimationKey({kind: 'figure', uid: 1}, 'rotation', 0, 1); editor.select(1);
  const native = clone(editor.report.keyframes), angle = editor.object.angles[0]; editor.resetPoseInFrames(undefined, {ticks: [2, 8]});
  for (const tick of [2, 8]) { editor.seek(tick); assert.deepEqual(editor.object.angles, editor.figure.segments.map(segment => segment.angle_rad)); }
  assert.deepEqual(editor.report.keyframes, native); editor.undo(); editor.seek(8); near(editor.object.angles[0], angle);
});
