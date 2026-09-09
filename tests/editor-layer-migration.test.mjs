import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {planLayerMembershipMigration, LAYER_MIGRATION_LIMITS} from '../src/editor-layer-migration.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';

function fixture({joined = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 80, 20].map((x, index) => {
    const a = createObject(figure, 1, x, 100), b = createObject(figure, 2, x + 200, 200), c = createObject(figure, 3, 600 - x, 300);
    a.angles = a.angles.map(angle => angle + index * .2);
    if (joined) { b.join = {target_object_slot: 0, target_handle_id: 1}; b.angles = b.angles.map(angle => angle + index * .2); }
    const frame = createFrame([a, b, c], 10); frame.unknown_native = {value: 51}; return frame;
  });
  const editor = new Editor({demo: false}).load(report);
  editor.createLayer('Second'); editor.createLayer('Unchanged');
  editor.assignFiguresToLayer([2], 'layer-2'); editor.assignFiguresToLayer([3], 'layer-3');
  return editor;
}
function authored(editor, id, entries) {
  return editor.addAnimationKeys(entries.map(([tick, index, interpolation = 'linear']) => ({target: {kind: 'layer', id}, property: 'pose', tick,
    value: {frameId: index === null ? null : editor.getFrameId(index)}, interpolation})));
}
function samples(editor) {
  return Array.from({length: editor.totalTicks}, (_, tick) => {
    editor.seek(tick); const frame = editor.evaluatedFrame, geometry = buildGeometry(editor.report, frame);
    return frame.objects.map(object => {
      const posed = geometry.objects.get(object.object_slot);
      return {uid: object.unique_id, scale: object.scale, opacity: object.field28,
        join: object.join ? frame.objects[object.join.target_object_slot].unique_id : null,
        points: [posed.root, ...posed.segments.flatMap(segment => [segment.start, segment.end])].flatMap(point => [point.x, point.y])};
    }).sort((a, b) => a.uid - b.uid);
  });
}
function equivalent(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((frame, tick) => {
    assert.deepEqual(frame.map(object => object.uid), expected[tick].map(object => object.uid), `presence at tick ${tick}`);
    frame.forEach((object, i) => {
      const before = expected[tick][i]; assert.equal(object.join, before.join); assert.equal(object.opacity, before.opacity);
      assert.ok(Math.abs(object.scale - before.scale) < 1e-8);
      object.points.forEach((value, index) => assert.ok(Math.abs(value - before.points[index]) < 1e-7, `geometry at tick ${tick}, UID ${object.uid}, coordinate ${index}: ${value} != ${before.points[index]}`));
    });
  });
}
function applyPlan(editor, plan, uids, target, {deletedLayerId} = {}) {
  const metadata = editor.report._styk, state = metadata.layers;
  for (const uid of uids) state.assignments[uid] = target;
  if (deletedLayerId) {
    state.order = state.order.filter(id => id !== deletedLayerId); delete state.byId[deletedLayerId];
    if (state.defaultLayerId === deletedLayerId) state.defaultLayerId = target;
    if (state.activeId === deletedLayerId) state.activeId = target;
  }
  metadata.animation = plan.afterAnimation;
  Object.assign(metadata.frameSources ??= {}, plan.frameSources);
  editor._nextFrameIdentity = plan.nextFrameIdentity; editor._initializeLayers(); editor._invalidate({timing: true});
}

test('planning a native-only membership edit is constant-sized and needs no pose assets', () => {
  const editor = fixture(), before = editor.serialize(), identity = editor._nextFrameIdentity;
  assert.equal(planLayerMembershipMigration(editor, [1], 'layer-2'), null);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._nextFrameIdentity, identity);
});

test('moving into an independently timed destination preserves every composed frame and unrelated channels', () => {
  const editor = fixture();
  authored(editor, 'layer-1', [[0, 0], [13, 1], [20, 2]]);
  authored(editor, 'layer-2', [[0, 1, 'hold'], [6, 2], [20, 0]]);
  authored(editor, 'layer-3', [[0, 2], [20, 0]]);
  editor.addAnimationKey({kind: 'figure', uid: 1}, 'scale', 0, 1.3);
  const before = samples(editor), native = editor.report.keyframes, nativeData = structuredClone(native), animation = editor.report._styk.animation;
  const identity = editor._nextFrameIdentity, plan = planLayerMembershipMigration(editor, [1], 'layer-2');
  assert.equal(plan.beforeAnimation, animation); assert.equal(editor.report._styk.animation, animation);
  assert.equal(editor._nextFrameIdentity, identity); assert.equal(editor.report._styk.frameSources, undefined);
  assert.equal(plan.sampledTicks, before.length); assert.ok(plan.frameSourceChanges.every(change => !change.before.exists && change.after.exists));
  for (const channel of animation.channels.filter(channel => channel.target.id !== 'layer-2')) assert.ok(plan.afterAnimation.channels.includes(channel));
  applyPlan(editor, plan, [1], 'layer-2'); equivalent(samples(editor), before);
  assert.equal(editor.report.keyframes, native); assert.deepEqual(native, nativeData); validateAnimationDocument(editor.report);
});

test('moving an independently timed source into a native destination preserves appearance gaps', () => {
  const editor = fixture(); authored(editor, 'layer-1', [[0, 0], [4, null], [11, 2]]);
  const before = samples(editor), plan = planLayerMembershipMigration(editor, [1], 'layer-2');
  applyPlan(editor, plan, [1], 'layer-2'); equivalent(samples(editor), before);
  assert.deepEqual(before[7].map(object => object.uid), [2, 3]);
});

test('cross-layer attached figures retain geometry with absolute scalar overlays applied once', () => {
  const editor = fixture({joined: true});
  authored(editor, 'layer-1', [[0, 1], [16, 2], [20, 0]]);
  authored(editor, 'layer-2', [[0, 0], [5, 2], [20, 1]]);
  editor.addAnimationKeys([{target: {kind: 'figure', uid: 1}, property: 'rotation', tick: 0, value: .7},
    {target: {kind: 'figure', uid: 1}, property: 'scale', tick: 0, value: 1.4},
    {target: {kind: 'figure', uid: 2}, property: 'opacity', tick: 0, value: .4}]);
  const before = samples(editor), plan = planLayerMembershipMigration(editor, [2], 'layer-1');
  applyPlan(editor, plan, [2], 'layer-1'); equivalent(samples(editor), before);
});

test('deleting the default layer preserves its implicit members and removes only its pose channel', () => {
  const editor = fixture(); authored(editor, 'layer-1', [[0, 2], [17, 0]]); authored(editor, 'layer-2', [[0, 1], [20, 2]]);
  const before = samples(editor), unrelated = editor.animationChannel({kind: 'layer', id: 'layer-2'}, 'pose');
  const plan = planLayerMembershipMigration(editor, [1], 'layer-2', {deletedLayerId: 'layer-1'});
  assert.ok(!plan.afterAnimation.channels.some(channel => channel.target.id === 'layer-1'));
  assert.ok(!plan.afterAnimation.channels.includes(unrelated));
  applyPlan(editor, plan, [1], 'layer-2', {deletedLayerId: 'layer-1'}); equivalent(samples(editor), before);
  const saved = editor.serialize(), reopened = new Editor({demo: false}).load(structuredClone(saved));
  equivalent(samples(reopened), before); assert.equal(reopened.report._styk.layers.defaultLayerId, 'layer-2');
});

test('unsafe preservation budgets and invalid targets fail before publishing data or consuming IDs', () => {
  const editor = fixture(); authored(editor, 'layer-1', [[0, 0], [LAYER_MIGRATION_LIMITS.maxTicks + 1, 1]]);
  const before = structuredClone(editor.report), identity = editor._nextFrameIdentity, history = editor._undo.length;
  assert.throws(() => planLayerMembershipMigration(editor, [1], 'layer-2'), /10,000 sampled frames/);
  assert.throws(() => planLayerMembershipMigration(editor, [1], '__proto__'), /destination/);
  assert.deepEqual(editor.report, before); assert.equal(editor._nextFrameIdentity, identity); assert.equal(editor._undo.length, history);
});

test('deleting an empty authored layer only removes its track and does not sample the scene', () => {
  const editor = fixture(); editor.createLayer('Empty'); authored(editor, 'layer-4', [[0, null]]);
  const plan = planLayerMembershipMigration(editor, [], 'layer-2', {deletedLayerId: 'layer-4'});
  assert.equal(plan.sampledTicks, 0); assert.deepEqual(plan.frameSources, {}); assert.equal(plan.afterAnimation.channels.length, 0);
});

test('public membership changes preserve independently timed animation in one exact undo and redo', () => {
  const editor = fixture({joined: true}); authored(editor, 'layer-1', [[0, 1], [13, 0], [20, 2]]);
  authored(editor, 'layer-2', [[0, 0], [5, 2], [20, 1]]);
  editor.addAnimationKeys([{target: {kind: 'figure', uid: 1}, property: 'rotation', tick: 0, value: .6},
    {target: {kind: 'figure', uid: 2}, property: 'scale', tick: 0, value: 1.2}]);
  const beforeSamples = samples(editor), before = structuredClone(editor.serialize()), history = editor._undo.length;
  const native = editor.report.keyframes, scalar = editor.animationChannel({kind: 'figure', uid: 1}, 'rotation');
  editor.assignFiguresToLayer([2], 'layer-1');
  assert.equal(editor._undo.length, history + 1); assert.equal(editor.report.keyframes, native);
  assert.equal(editor.animationChannel({kind: 'figure', uid: 1}, 'rotation'), scalar); equivalent(samples(editor), beforeSamples);
  const after = structuredClone(editor.serialize());
  editor.undo(); assert.deepEqual(editor.serialize(), before); assert.equal(editor.report._styk.frameSources, undefined);
  assert.equal(editor.animationChannel({kind: 'figure', uid: 1}, 'rotation'), scalar); equivalent(samples(editor), beforeSamples);
  editor.redo(); assert.deepEqual(editor.serialize(), after); equivalent(samples(editor), beforeSamples);
  const reopened = new Editor({demo: false}).load(structuredClone(after)); equivalent(samples(reopened), beforeSamples);
  assert.equal(reopened.layerForUid(2), 'layer-1');
});

test('public default-layer deletion restores channel order, memberships and source assets on undo', () => {
  const editor = fixture(); authored(editor, 'layer-3', [[0, 1], [20, 2]]); authored(editor, 'layer-1', [[0, 2], [17, 0]]);
  authored(editor, 'layer-2', [[0, 1], [20, 2]]);
  const beforeSamples = samples(editor), before = structuredClone(editor.serialize()), history = editor._undo.length;
  const untouched = editor.animationChannel({kind: 'layer', id: 'layer-3'}, 'pose');
  editor.deleteLayer('layer-1', {targetLayerId: 'layer-2'});
  assert.equal(editor._undo.length, history + 1); assert.equal(editor.layerForUid(1), 'layer-2');
  assert.equal(editor.animationChannel({kind: 'layer', id: 'layer-3'}, 'pose'), untouched);
  equivalent(samples(editor), beforeSamples); const after = structuredClone(editor.serialize());
  editor.undo(); assert.deepEqual(editor.serialize(), before); assert.equal(editor.report._styk.frameSources, undefined);
  equivalent(samples(editor), beforeSamples); assert.equal(editor.layerForUid(1), 'layer-1');
  editor.redo(); assert.deepEqual(editor.serialize(), after); equivalent(samples(editor), beforeSamples);
});

test('public oversized migration rejection leaves assignments, sources, history and identities unchanged', () => {
  const editor = fixture(); authored(editor, 'layer-1', [[0, 0], [LAYER_MIGRATION_LIMITS.maxTicks + 1, 1]]);
  const before = structuredClone(editor.report), history = editor._undo.length, identity = editor._nextFrameIdentity;
  assert.throws(() => editor.assignFiguresToLayer([1], 'layer-2'), /10,000 sampled frames/);
  assert.throws(() => editor.deleteLayer('layer-1', {targetLayerId: 'layer-2'}), /10,000 sampled frames/);
  assert.deepEqual(editor.report, before); assert.equal(editor._undo.length, history); assert.equal(editor._nextFrameIdentity, identity);
});
